import React, { useState, useEffect, useRef } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { FaPlus, FaSearch, FaEdit, FaTrash, FaCamera } from 'react-icons/fa';
import Spinner from '../components/Spinner';
import Modal from '../components/Modal';
import moment from 'moment';
import useCurrency from '../hooks/useCurrency';
import { expenseCategories, incomeCategories } from '../constants/categories';

const formatDateTimeLocal = (dateString) => {
    const date = moment(dateString);
    return date.isValid() ? date.format('YYYY-MM-DDTHH:mm') : '';
};

const TransactionsPage = () => {
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState({ description: '', category: '', account: '' });
  const { formatCurrency, settings } = useCurrency(); 
  const [newTxForm, setNewTxForm] = useState({
    description: '',
    amount: '',
    type: 'expense',
    category: 'Uncategorized',
    date: formatDateTimeLocal(new Date()), 
    account: '',
  });
  const [initialLoading, setInitialLoading] = useState(true); 
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const fileInputRef = useRef(null);

  const fetchAccounts = async () => {
    try {
      const { data } = await api.get('/accounts');
      setAccounts(data);
      if (data.length > 0 && !newTxForm.account) { 
        setNewTxForm(prev => ({ ...prev, account: data[0]._id }));
      }
    } catch (error) {
      toast.error('Failed to fetch accounts');
    }
  };

  const fetchTransactions = async (reset = false) => {
    if (!settings) return;

    try {
      setLoading(true);
      const currentPage = reset ? 1 : page;
      const params = new URLSearchParams({ page: currentPage, limit: 10, ...filters });
      const { data } = await api.get(`/transactions?${params.toString()}`);

      const transactionsWithAccount = data.transactions.map(tx => ({
          ...tx,
          account: tx.account || { name: 'N/A' } 
      }));

      if (reset) {
        setTransactions(transactionsWithAccount);
      } else {
        setTransactions(prev => [...prev, ...transactionsWithAccount]);
      }
      setTotalPages(data.totalPages);
    } catch (error) {
      toast.error('Failed to fetch transactions');
    } finally {
      setLoading(false);
      setInitialLoading(false);
    }
  };

  useEffect(() => {
    if(settings) { 
        fetchAccounts();
    }
  }, [settings]);

  useEffect(() => {
    if(settings) {
        setTransactions([]);
        setPage(1); 
        fetchTransactions(true);
    }
  }, [filters, settings]); 

  const handleLoadMore = () => {
    if (page < totalPages) {
      setPage(prev => prev + 1);
    }
  };

  useEffect(() => {
      if (page > 1 && settings) {
          fetchTransactions(false);
      }
  }, [page, settings]); 

  // --- FIX: Correct state handler logic to protect manual category selection ---
  const handleFormChange = (e) => {
    const { name, value } = e.target;
    setNewTxForm(prev => {
      const newState = { ...prev, [name]: value };
      if (name === 'type') {
        newState.category = value === 'income' ? incomeCategories[0] : expenseCategories[0];
      }
      return newState;
    });
  };

  const handleFilterChange = (e) => {
      setFilters({ ...filters, [e.target.name]: e.target.value });
  };

  // --- FIX: Correct edit handler state replication matching form configurations ---
  const handleEditFormChange = (e) => {
     const { name, value } = e.target;
     setEditingTransaction(prev => {
        const newState = { ...prev, [name]: value };
        if (name === 'type') {
           newState.category = value === 'income' ? incomeCategories[0] : expenseCategories[0];
        }
        return newState; 
     });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const { data } = await api.post('/transactions', {
          ...newTxForm,
          amount: Number(newTxForm.amount)
      });
      const accountInfo = accounts.find(a => a._id === data.account);
      setTransactions([{ ...data, account: accountInfo || { name: 'N/A' } }, ...transactions]);
      toast.success('Transaction added!');
      setNewTxForm(prev => ({
        ...prev,
        description: '',
        amount: '',
        category: 'Uncategorized',
        type: 'expense',
        date: formatDateTimeLocal(new Date()), 
      }));
      fetchAccounts(); 
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to add transaction');
    }
  };

  const handleDelete = async (id) => {
      if (window.confirm('Are you sure you want to delete this transaction?')) {
          try {
              await api.delete(`/transactions/${id}`);
              setTransactions(transactions.filter(tx => tx._id !== id));
              toast.success('Transaction deleted!');
              fetchAccounts(); 
          } catch (error) {
              toast.error('Failed to delete transaction');
          }
      }
  };

  const handleEditClick = (tx) => {
      setEditingTransaction({
          ...tx,
          date: formatDateTimeLocal(tx.date),
          account: tx.account?._id 
      });
      setIsModalOpen(true);
  };

  const handleUpdate = async (e) => {
      e.preventDefault();
      try {
           const { data } = await api.put(`/transactions/${editingTransaction._id}`, {
              ...editingTransaction,
              amount: Number(editingTransaction.amount)
           });
          const accountInfo = accounts.find(a => a._id === data.account);
          const updatedTx = { ...data, account: accountInfo || { name: 'N/A' }};

          setTransactions(transactions.map(tx => (tx._id === data._id ? updatedTx : tx)));

          toast.success('Transaction updated!');
          setIsModalOpen(false);
          setEditingTransaction(null);
          fetchAccounts(); 
      } catch (error) {
          toast.error(error.response?.data?.message || 'Failed to update transaction');
      }
  };

  // --- FIX: Integrated smart categorization upload block ---
  const handleImageUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        toast.error('Please upload an image file (JPG, PNG, etc.).');
        if (fileInputRef.current) fileInputRef.current.value = ""; 
        return;
    }

    setOcrLoading(true);
    toast.loading('Uploading & Scanning bill...');

    const formData = new FormData();
    formData.append('file', file); 

    try {
      const { data } = await api.post('/ocr/scan-receipt', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      toast.dismiss();

      if (data.success) {
        toast.success('Scan complete! Check form data.');
        console.log("Parsed Data from Backend:", data);

        setNewTxForm(prev => {
          const nextType = 'expense';
          const isGrocery = data.description?.toLowerCase().includes('agriculture') || 
                           data.description?.toLowerCase().includes('fruits') || 
                           data.description?.toLowerCase().includes('vegetable');
                           
          return {
            ...prev,
            description: data.description || 'Scanned Bill',
            amount: data.amount || '',
            date: data.date ? formatDateTimeLocal(data.date) : prev.date,
            type: nextType,
            category: isGrocery ? 'Food & Groceries' : 'Shopping/Apparel', 
          };
        });
      } else {
        toast.error(data.message || "Failed to extract data from bill.");
      }

    } catch (error) {
      toast.dismiss();
      console.error("OCR Upload/Scan Error:", error.response || error);
      toast.error(error.response?.data?.message || "Failed to scan bill.");
    } finally {
      setOcrLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const currentCategories = newTxForm.type === 'income' ? incomeCategories : expenseCategories;

  if (initialLoading) return <Spinner />;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* --- ADD TRANSACTION FORM --- */}
        <div className="md:col-span-1">
          <div className="bg-white p-6 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold mb-4">Add Transaction</h2>
            <div className="mb-4">
              <input type="file" accept="image/*" onChange={handleImageUpload} ref={fileInputRef} style={{ display: 'none' }} id="imageUpload"/>
              <button
                type="button"
                onClick={() => fileInputRef.current.click()}
                className={`w-full bg-teal-500 text-white py-2 px-4 rounded-lg hover:bg-teal-600 flex items-center justify-center space-x-2 ${ocrLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                disabled={ocrLoading} >
                <FaCamera />
                <span>{ocrLoading ? `Scanning...` : 'Scan Bill'}</span>
              </button>
               {ocrLoading && <div className="w-full bg-gray-200 rounded-full h-1 mt-1"><div className="bg-teal-500 h-1 rounded-full animate-pulse"></div></div>} 
               <p className="text-xs text-gray-500 mt-1">Upload bill image (JPG, PNG).</p>
            </div>

            <form onSubmit={handleSubmit}>
              {/* Account */}
              <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="account">Account</label>
                <select name="account" id="account" value={newTxForm.account} onChange={handleFormChange} className="w-full px-3 py-2 border rounded-lg bg-white" required>
                  {accounts.length === 0 ? ( <option disabled value="">Create an account first</option> ) :
                   ( accounts.map(acc => <option key={acc._id} value={acc._id}>{acc.name}</option>) )}
                </select>
              </div>
              {/* Description */}
              <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="description">Description</label>
                <input type="text" name="description" id="description" value={newTxForm.description} onChange={handleFormChange} className="w-full px-3 py-2 border rounded-lg" required />
              </div>
              {/* Amount */}
              <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="amount">Amount (in INR)</label>
                <input type="number" step="0.01" name="amount" id="amount" value={newTxForm.amount} onChange={handleFormChange} className="w-full px-3 py-2 border rounded-lg" required />
              </div>
              {/* Type */}
              <div className="mb-4">
                <label className="block text-gray-700 mb-2">Type</label>
                <div className="flex">
                  <label className="mr-4"><input type="radio" name="type" value="expense" checked={newTxForm.type === 'expense'} onChange={handleFormChange} /> Expense</label>
                  <label><input type="radio" name="type" value="income" checked={newTxForm.type === 'income'} onChange={handleFormChange} /> Income</label>
                </div>
              </div>
              {/* Category */}
              <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="category">Category</label>
                <select 
                  name="category" 
                  id="category" 
                  value={newTxForm.category} 
                  onChange={handleFormChange} 
                  className="w-full px-3 py-2 border rounded-lg bg-white" 
                  required
                >
                  {currentCategories.map(category => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </div>
              {/* Date & Time */}
              <div className="mb-4">
                <label className="block text-gray-700 mb-2" htmlFor="date">Date & Time</label>
                <input type="datetime-local" name="date" id="date" value={newTxForm.date} onChange={handleFormChange} className="w-full px-3 py-2 border rounded-lg" required />
              </div>
              <button type="submit" className="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700 flex items-center justify-center space-x-2">
                <FaPlus />
                <span>Add Transaction</span>
              </button>
            </form>
          </div>
        </div>

        {/* --- TRANSACTIONS LIST & FILTERS --- */}
        <div className="md:col-span-2">
          <h1 className="text-3xl font-bold mb-6">Recent Transactions</h1>
          <div className="bg-white p-4 rounded-lg shadow-md mb-4 flex items-center space-x-2">
              <input type="text" name="description" placeholder="Search description..." value={filters.description} onChange={handleFilterChange} className="w-full px-3 py-2 border rounded-lg" />
              <input type="text" name="category" placeholder="Search category..." value={filters.category} onChange={handleFilterChange} className="w-full px-3 py-2 border rounded-lg" />
              <select name="account" value={filters.account} onChange={handleFilterChange} className="w-full px-3 py-2 border rounded-lg bg-white">
                  <option value="">All Accounts</option>
                  {accounts.map(acc => <option key={acc._id} value={acc._id}>{acc.name}</option>)}
              </select>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-md">
            {loading && transactions.length === 0 ? <Spinner /> :
              transactions.length === 0 ? <p>No transactions found.</p> :
              (
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="py-2 px-4 text-left">Date & Time</th>
                      <th className="py-2 px-4 text-left">Description</th>
                      <th className="py-2 px-4 text-left">Category</th>
                      <th className="py-2 px-4 text-left">Account</th>
                      <th className="py-2 px-4 text-right">Amount</th>
                      <th className="py-2 px-4 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map(tx => (
                      <tr key={tx._id} className="border-b hover:bg-gray-50">
                        <td className="py-2 px-4 whitespace-nowrap">{moment(tx.date).format('YYYY-MM-DD HH:mm')}</td>
                        <td className="py-2 px-4">{tx.description}</td>
                        <td className="py-2 px-4"><span className="bg-gray-200 rounded-full px-2 py-1 text-sm">{tx.category}</span></td>
                        <td className="py-2 px-4">{tx.account?.name || 'N/A'}</td>
                        <td className={`py-2 px-4 text-right font-semibold ${tx.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                          {tx.type === 'income' ? '+' : '-'} {formatCurrency(tx.amount)}
                        </td>
                        <td className="py-2 px-4 text-center">
                          <button onClick={() => handleEditClick(tx)} className="text-blue-500 hover:text-blue-700 mr-2">
                              <FaEdit />
                          </button>
                          <button onClick={() => handleDelete(tx._id)} className="text-red-500 hover:text-red-700">
                              <FaTrash />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )
            }
            {page < totalPages && (
              <button
                onClick={handleLoadMore}
                className="w-full mt-4 bg-gray-200 text-gray-800 py-2 rounded-lg hover:bg-gray-300"
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Load More'}
              </button>
            )}
          </div>
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Edit Transaction"
      >
          {editingTransaction && (
              <form onSubmit={handleUpdate}>
                  {/* Account */}
                  <div className="mb-4">
                    <label className="block text-gray-700 mb-2" htmlFor="edit-account">Account</label>
                    <select name="account" id="edit-account" value={editingTransaction.account} onChange={handleEditFormChange} className="w-full px-3 py-2 border rounded-lg bg-white" required>
                        {accounts.map(acc => <option key={acc._id} value={acc._id}>{acc.name}</option>)}
                    </select>
                  </div>
                   {/* Description */}
                  <div className="mb-4">
                    <label className="block text-gray-700 mb-2" htmlFor="edit-description">Description</label>
                    <input type="text" name="description" id="edit-description" value={editingTransaction.description} onChange={handleEditFormChange} className="w-full px-3 py-2 border rounded-lg" required />
                  </div>
                  {/* Amount */}
                  <div className="mb-4">
                    <label className="block text-gray-700 mb-2" htmlFor="edit-amount">Amount (in INR)</label>
                    <input type="number" step="0.01" name="amount" id="edit-amount" value={editingTransaction.amount} onChange={handleEditFormChange} className="w-full px-3 py-2 border rounded-lg" required />
                  </div>
                  {/* Type */}
                  <div className="mb-4">
                    <label className="block text-gray-700 mb-2">Type</label>
                    <div className="flex">
                      <label className="mr-4"><input type="radio" name="type" value="expense" checked={editingTransaction.type === 'expense'} onChange={handleEditFormChange} /> Expense</label>
                      <label><input type="radio" name="type" value="income" checked={editingTransaction.type === 'income'} onChange={handleEditFormChange} /> Income</label>
                    </div>
                  </div>
                  {/* Category */}
                  <div className="mb-4">
                    <label className="block text-gray-700 mb-2" htmlFor="edit-category">Category</label>
                    <select 
                      name="category" 
                      id="edit-category" 
                      value={editingTransaction.category} 
                      onChange={handleEditFormChange} 
                      className="w-full px-3 py-2 border rounded-lg bg-white" 
                      required
                    >
                      {(editingTransaction.type === 'income' ? incomeCategories : expenseCategories)
                        .map(category => (
                          <option key={category} value={category}>{category}</option>
                      ))}
                    </select>
                  </div>
                  {/* Date & Time */}
                  <div className="mb-4">
                    <label className="block text-gray-700 mb-2" htmlFor="edit-date">Date & Time</label>
                    <input type="datetime-local" name="date" id="edit-date" value={editingTransaction.date} onChange={handleEditFormChange} className="w-full px-3 py-2 border rounded-lg" required />
                  </div>
                  <button type="submit" className="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700">
                    Save Changes
                  </button>
              </form>
          )}
      </Modal>
    </>
  );
};

export default TransactionsPage;
