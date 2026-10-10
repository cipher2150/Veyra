// SplitLedger Frontend Application State & Controllers

const API_BASE = '/api';
let authToken = localStorage.getItem('split_token') || null;
let currentUser = JSON.parse(localStorage.getItem('split_user') || 'null');

let currentGroupId = null; // null means Global Overview
let currentGroupData = null;
let currentGroupMembers = [];

let searchTimeout = null;
let globalTxPage = 1;
let groupTxPage = 1;

// Init app on page load
document.addEventListener('DOMContentLoaded', () => {
  if (authToken && currentUser) {
    showAppView();
    loadUserData();
    loadGroups();
    selectGroup(null);
  } else {
    showAuthView();
  }
});

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

// API Fetch Helper with Auth & Error Handling
async function apiFetch(endpoint, options = {}) {
  const headers = options.headers || {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (res.status === 401 || res.status === 403) {
      if (endpoint !== '/auth/login' && endpoint !== '/auth/register') {
        handleLogout();
        throw new Error('Session expired. Please log in again.');
      }
    }

    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      throw err;
    }

    return data;
  } catch (err) {
    throw err;
  }
}

// -------------------------------------------------------------
// AUTHENTICATION CONTROLLERS
// -------------------------------------------------------------

function showAuthView() {
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
}

function showAppView() {
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  updateUserHeader();
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('login-form');
  const regForm = document.getElementById('register-form');
  const loginBtn = document.getElementById('tab-login-btn');
  const regBtn = document.getElementById('tab-register-btn');
  const errorBox = document.getElementById('auth-error');
  errorBox.classList.add('hidden');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    regForm.classList.add('hidden');
    loginBtn.classList.add('active');
    regBtn.classList.remove('active');
  } else {
    loginForm.classList.add('hidden');
    regForm.classList.remove('hidden');
    loginBtn.classList.remove('active');
    regBtn.classList.add('active');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorBox = document.getElementById('auth-error');
  const submitBtn = document.getElementById('login-submit-btn');

  errorBox.classList.add('hidden');
  submitBtn.disabled = true;

  try {
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      body: { email, password },
    });

    authToken = res.token;
    currentUser = res.user;
    localStorage.setItem('split_token', authToken);
    localStorage.setItem('split_user', JSON.stringify(currentUser));

    showAppView();
    loadUserData();
    loadGroups();
    selectGroup(null);
    showToast(`Welcome back, ${currentUser.name}!`, 'success');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  const errorBox = document.getElementById('auth-error');
  const submitBtn = document.getElementById('register-submit-btn');

  errorBox.classList.add('hidden');
  submitBtn.disabled = true;

  try {
    const res = await apiFetch('/auth/register', {
      method: 'POST',
      body: { name, email, password },
    });

    authToken = res.token;
    currentUser = res.user;
    localStorage.setItem('split_token', authToken);
    localStorage.setItem('split_user', JSON.stringify(currentUser));

    showAppView();
    loadUserData();
    loadGroups();
    selectGroup(null);
    showToast(`Account created! Welcome, ${currentUser.name}`, 'success');
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
  }
}

function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('split_token');
  localStorage.removeItem('split_user');
  showAuthView();
  showToast('Logged out successfully', 'info');
}

function updateUserHeader() {
  if (!currentUser) return;
  document.getElementById('user-display-name').textContent = currentUser.name;
  document.getElementById('user-avatar').textContent = currentUser.name.charAt(0).toUpperCase();
}

async function loadUserData() {
  try {
    const data = await apiFetch('/auth/me');
    const net = parseFloat(data.global_rupees);
    const balEl = document.getElementById('user-global-balance');
    const valEl = document.getElementById('global-net-val');
    const subEl = document.getElementById('global-net-sub');

    if (net > 0) {
      balEl.textContent = `You are owed ₹${data.global_rupees}`;
      balEl.style.color = 'var(--success)';
      valEl.textContent = `+₹${data.global_rupees}`;
      valEl.className = 'metric-value text-success';
      subEl.textContent = 'Others owe you in total';
    } else if (net < 0) {
      const absVal = Math.abs(net).toFixed(2);
      balEl.textContent = `You owe ₹${absVal}`;
      balEl.style.color = 'var(--danger)';
      valEl.textContent = `-₹${absVal}`;
      valEl.className = 'metric-value text-danger';
      subEl.textContent = 'You owe others across groups';
    } else {
      balEl.textContent = `Net: ₹0.00`;
      balEl.style.color = 'var(--text-secondary)';
      valEl.textContent = `₹0.00`;
      valEl.className = 'metric-value';
      subEl.textContent = 'Completely settled up';
    }
  } catch (err) {
    console.error('Failed to load user profile:', err);
  }
}

// -------------------------------------------------------------
// GROUPS MANAGEMENT
// -------------------------------------------------------------

async function loadGroups() {
  try {
    const groups = await apiFetch('/groups');
    const container = document.getElementById('groups-list');
    const countEl = document.getElementById('global-groups-count');
    if (countEl) countEl.textContent = groups.length;

    if (groups.length === 0) {
      container.innerHTML = '<div class="empty-state-sm">No groups yet. Create one!</div>';
      return;
    }

    container.innerHTML = groups.map(g => {
      const net = parseFloat(g.user_net_rupees);
      let netHtml = '<span class="group-item-bal text-muted">₹0.00</span>';
      if (net > 0) {
        netHtml = `<span class="group-item-bal text-success">+₹${g.user_net_rupees}</span>`;
      } else if (net < 0) {
        netHtml = `<span class="group-item-bal text-danger">-₹${Math.abs(net).toFixed(2)}</span>`;
      }

      const isActive = currentGroupId === g.id ? 'active' : '';

      return `
        <button class="group-item-btn ${isActive}" onclick="selectGroup(${g.id})">
          <div class="group-name-col">
            <span>${escapeHtml(g.name)}</span>
          </div>
          ${netHtml}
        </button>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load groups:', err);
  }
}

async function selectGroup(groupId) {
  currentGroupId = groupId;
  const globalBtn = document.getElementById('nav-global-btn');
  const globalView = document.getElementById('global-view');
  const groupView = document.getElementById('group-view');

  // Update active state in group list buttons
  const groupButtons = document.querySelectorAll('.group-item-btn');
  groupButtons.forEach(btn => btn.classList.remove('active'));

  if (!groupId) {
    globalBtn.classList.add('active');
    globalView.classList.remove('hidden');
    groupView.classList.add('hidden');
    loadGlobalOverview();
  } else {
    globalBtn.classList.remove('active');
    globalView.classList.add('hidden');
    groupView.classList.remove('hidden');
    loadGroupDetails(groupId);
  }
}

async function handleCreateGroup(e) {
  e.preventDefault();
  const name = document.getElementById('new-group-name').value;
  const type = document.getElementById('new-group-type').value;

  try {
    const group = await apiFetch('/groups', {
      method: 'POST',
      body: { name, type },
    });

    closeModal('create-group-modal');
    document.getElementById('new-group-name').value = '';
    showToast(`Group "${group.name}" created!`, 'success');
    await loadGroups();
    selectGroup(group.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openAddMemberModal() {
  document.getElementById('member-email-input').value = '';
  document.getElementById('add-member-error').classList.add('hidden');
  openModal('add-member-modal');
}

async function handleAddMember(e) {
  e.preventDefault();
  const email = document.getElementById('member-email-input').value;
  const errorBox = document.getElementById('add-member-error');

  try {
    await apiFetch(`/groups/${currentGroupId}/members`, {
      method: 'POST',
      body: { email },
    });

    closeModal('add-member-modal');
    showToast(`Member added to group!`, 'success');
    loadGroupDetails(currentGroupId);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  }
}

// -------------------------------------------------------------
// GLOBAL VIEW LOGIC
// -------------------------------------------------------------

async function loadGlobalOverview() {
  loadUserData();
  loadGlobalSimplifiedDebts();
  loadGlobalTransactions();
}

async function loadGlobalSimplifiedDebts() {
  try {
    const data = await apiFetch('/balances/global');
    const container = document.getElementById('global-simplified-list');
    const simplified = data.simplified.all;

    if (!simplified || simplified.length === 0) {
      container.innerHTML = '<div class="empty-state">No outstanding settlements across your groups! Everything is balanced. 🎉</div>';
      return;
    }

    container.innerHTML = simplified.map(s => {
      const isFromMe = s.fromUserId === currentUser.id;
      const isToMe = s.toUserId === currentUser.id;

      let settleActionBtn = '';
      if (isFromMe) {
        settleActionBtn = `
          <button class="btn btn-outline-primary btn-xs" onclick="quickSettle(${s.fromUserId}, ${s.toUserId}, '${s.amountRupees}')">
            Settle Up
          </button>
        `;
      }

      return `
        <div class="simplified-card">
          <div class="transfer-flow">
            <span class="transfer-from">${escapeHtml(s.fromUserName)}${isFromMe ? ' (You)' : ''}</span>
            <span class="transfer-arrow">➔ pays ➔</span>
            <span class="transfer-to">${escapeHtml(s.toUserName)}${isToMe ? ' (You)' : ''}</span>
          </div>
          <div class="flex-align-gap">
            <span class="transfer-amount">₹${s.amountRupees}</span>
            ${settleActionBtn}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load global simplified debts:', err);
  }
}

async function loadGlobalTransactions() {
  const search = document.getElementById('global-search-input').value;
  const type = document.getElementById('global-type-filter').value;
  const tbody = document.getElementById('global-tx-tbody');

  let query = `?page=${globalTxPage}&limit=10`;
  if (type) query += `&type=${type}`;
  if (search) query += `&search=${encodeURIComponent(search)}`;

  try {
    const data = await apiFetch(`/transactions${query}`);
    renderTransactionsTable(tbody, data.transactions, 'global-pagination-bar', data.pagination, false);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Failed to load transactions</td></tr>`;
  }
}

// -------------------------------------------------------------
// GROUP DETAIL VIEW LOGIC
// -------------------------------------------------------------

async function loadGroupDetails(groupId) {
  try {
    const data = await apiFetch(`/groups/${groupId}`);
    currentGroupData = data.group;
    currentGroupMembers = data.members;

    document.getElementById('group-title').textContent = data.group.name;
    document.getElementById('group-type-badge').textContent = data.group.type;
    document.getElementById('group-meta-info').textContent = `Created by ${data.group.created_by_name} • ${data.members.length} members`;
    document.getElementById('grp-members-count').textContent = data.members.length;

    // Current user's balance in this group
    const me = data.members.find(m => m.id === currentUser.id);
    const yourBal = me ? parseFloat(me.net_rupees) : 0;
    const yourBalEl = document.getElementById('grp-your-balance');
    const yourSubEl = document.getElementById('grp-your-sub');

    if (yourBal > 0) {
      yourBalEl.textContent = `+₹${me.net_rupees}`;
      yourBalEl.className = 'metric-value text-success';
      yourSubEl.textContent = 'You are owed money in this group';
    } else if (yourBal < 0) {
      yourBalEl.textContent = `-₹${Math.abs(yourBal).toFixed(2)}`;
      yourBalEl.className = 'metric-value text-danger';
      yourSubEl.textContent = 'You owe money in this group';
    } else {
      yourBalEl.textContent = '₹0.00';
      yourBalEl.className = 'metric-value';
      yourSubEl.textContent = 'You are settled up in this group';
    }

    loadGroupTransactions();
    loadGroupBalances();
    loadGroupActivity();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function switchGroupTab(tab) {
  const tabs = ['expenses', 'balances', 'activity'];
  tabs.forEach(t => {
    document.getElementById(`tab-btn-${t}`).classList.remove('active');
    document.getElementById(`group-tab-${t}`).classList.add('hidden');
  });

  document.getElementById(`tab-btn-${tab}`).classList.add('active');
  document.getElementById(`group-tab-${tab}`).classList.remove('hidden');

  if (tab === 'balances') loadGroupBalances();
  if (tab === 'activity') loadGroupActivity();
  if (tab === 'expenses') loadGroupTransactions();
}

async function loadGroupTransactions() {
  const search = document.getElementById('grp-search-input').value;
  const type = document.getElementById('grp-type-filter').value;
  const tbody = document.getElementById('grp-tx-tbody');

  let query = `?groupId=${currentGroupId}&page=${groupTxPage}&limit=10`;
  if (type) query += `&type=${type}`;
  if (search) query += `&search=${encodeURIComponent(search)}`;

  try {
    const data = await apiFetch(`/transactions${query}`);
    renderTransactionsTable(tbody, data.transactions, 'grp-pagination-bar', data.pagination, true);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-4">Failed to load transactions</td></tr>`;
  }
}

async function loadGroupBalances() {
  if (!currentGroupId) return;

  try {
    const data = await apiFetch(`/balances/group/${currentGroupId}`);

    // 1. Simplified Debts
    const simpContainer = document.getElementById('grp-simplified-list');
    const simplified = data.simplified.all;

    if (!simplified || simplified.length === 0) {
      simpContainer.innerHTML = '<div class="empty-state">All debts settled! No payments needed. 🎉</div>';
    } else {
      simpContainer.innerHTML = simplified.map(s => {
        const isFromMe = s.fromUserId === currentUser.id;
        const isToMe = s.toUserId === currentUser.id;

        return `
          <div class="simplified-card">
            <div class="transfer-flow">
              <span class="transfer-from">${escapeHtml(s.fromUserName)}${isFromMe ? ' (You)' : ''}</span>
              <span class="transfer-arrow">➔ pays ➔</span>
              <span class="transfer-to">${escapeHtml(s.toUserName)}${isToMe ? ' (You)' : ''}</span>
            </div>
            <div class="flex-align-gap">
              <span class="transfer-amount">₹${s.amountRupees}</span>
              <button class="btn btn-outline-primary btn-xs" onclick="quickSettle(${s.fromUserId}, ${s.toUserId}, '${s.amountRupees}')">
                Settle Up
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // 2. Member Balances Table
    const balTbody = document.getElementById('grp-members-balance-tbody');
    balTbody.innerHTML = data.allBalances.map(b => {
      let statusBadge = '<span class="status-badge settled">Settled</span>';
      let netDisplay = `<span class="font-mono">₹0.00</span>`;

      if (b.status === 'OWED') {
        statusBadge = '<span class="status-badge owed">Owed</span>';
        netDisplay = `<span class="font-mono text-success font-medium">+₹${b.netRupees}</span>`;
      } else if (b.status === 'OWES') {
        statusBadge = '<span class="status-badge owes">Owes</span>';
        netDisplay = `<span class="font-mono text-danger font-medium">-₹${Math.abs(parseFloat(b.netRupees)).toFixed(2)}</span>`;
      }

      return `
        <tr>
          <td><strong>${escapeHtml(b.name)}</strong>${b.userId === currentUser.id ? ' (You)' : ''}</td>
          <td class="text-muted text-sm">${escapeHtml(b.email)}</td>
          <td>${netDisplay}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');

    // 3. Direct Pairwise breakdown
    const directContainer = document.getElementById('grp-direct-list');
    const direct = data.direct.all;

    if (!direct || direct.length === 0) {
      directContainer.innerHTML = '<div class="empty-state">No direct pairwise debts.</div>';
    } else {
      directContainer.innerHTML = direct.map(d => `
        <div class="simplified-card">
          <div class="transfer-flow">
            <span class="transfer-from">${escapeHtml(d.fromUserName)}</span>
            <span class="transfer-arrow">➔ owes ➔</span>
            <span class="transfer-to">${escapeHtml(d.toUserName)}</span>
          </div>
          <span class="transfer-amount">₹${d.amountRupees}</span>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load group balances:', err);
  }
}

async function loadGroupActivity() {
  if (!currentGroupId) return;

  try {
    const logs = await apiFetch(`/groups/${currentGroupId}/activity`);
    const container = document.getElementById('grp-activity-timeline');

    if (!logs || logs.length === 0) {
      container.innerHTML = '<div class="empty-state">No activity logs recorded yet.</div>';
      return;
    }

    container.innerHTML = logs.map(l => {
      let actionTitle = '';
      if (l.action === 'GROUP_CREATED') actionTitle = `Group was created`;
      else if (l.action === 'MEMBER_ADDED') actionTitle = `Added member ${l.details.addedUserName || ''}`;
      else if (l.action === 'EXPENSE_CREATED') actionTitle = `Recorded expense "${l.details.description || ''}" (₹${l.details.amount || ''})`;
      else if (l.action === 'EXPENSE_UPDATED') actionTitle = `Updated expense "${l.details.description || ''}"`;
      else if (l.action === 'EXPENSE_DELETED') actionTitle = `Deleted / reversed expense #${l.details.originalTransactionId || ''}`;
      else if (l.action === 'SETTLEMENT_RECORDED') actionTitle = `Recorded settlement payment of ₹${l.details.amount || ''}`;
      else actionTitle = l.action;

      return `
        <div class="timeline-item">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-title">${escapeHtml(actionTitle)}</div>
            <div class="timeline-meta">${escapeHtml(l.user_name)} • ${formatDate(l.created_at)}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load group activity:', err);
  }
}

// -------------------------------------------------------------
// TRANSACTIONS TABLE RENDERING & ACTIONS
// -------------------------------------------------------------

function renderTransactionsTable(tbody, transactions, paginationBarId, pagination, isGroupView) {
  if (!transactions || transactions.length === 0) {
    const colSpan = isGroupView ? 7 : 8;
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="text-center text-muted py-4">No transactions recorded yet.</td></tr>`;
    document.getElementById(paginationBarId).innerHTML = '';
    return;
  }

  tbody.innerHTML = transactions.map(t => {
    let statusBadge = '<span class="status-badge settled">Active</span>';
    if (t.isReversed) {
      statusBadge = '<span class="status-badge reversed">Reversed</span>';
    } else if (t.type === 'REVERSAL') {
      statusBadge = '<span class="status-badge reversal">Reversal</span>';
    }

    const netVal = parseFloat(t.userNetRupees);
    let netHtml = '<span class="text-muted font-mono">₹0.00</span>';
    if (netVal > 0) {
      netHtml = `<span class="text-success font-mono font-medium">+₹${t.userNetRupees}</span>`;
    } else if (netVal < 0) {
      netHtml = `<span class="text-danger font-mono font-medium">-₹${Math.abs(netVal).toFixed(2)}</span>`;
    }

    const typeDisplay = t.type === 'EXPENSE' ? `Expense (${t.splitType || 'EQUAL'})` : t.type;

    let actionsHtml = `
      <div class="actions-row">
        <button class="btn btn-secondary btn-xs" onclick="inspectLedgerEntries(${t.id})" title="View double-entry postings">
          Ledger
        </button>
    `;

    // Only allow edit/delete on active expenses
    if (t.type === 'EXPENSE' && !t.isReversed) {
      actionsHtml += `
        <button class="btn btn-secondary btn-xs" onclick="openEditExpenseModal(${t.id})">Edit</button>
        <button class="btn btn-ghost btn-xs text-danger" onclick="deleteExpense(${t.id})" title="Reverse expense">Delete</button>
      `;
    }

    actionsHtml += `</div>`;

    if (isGroupView) {
      return `
        <tr>
          <td class="text-muted text-sm font-mono">${formatDate(t.createdAt)}</td>
          <td><strong>${escapeHtml(t.description)}</strong></td>
          <td class="text-sm">${escapeHtml(typeDisplay)}</td>
          <td class="font-mono font-medium">₹${t.amountRupees}</td>
          <td>${netHtml}</td>
          <td>${statusBadge}</td>
          <td>${actionsHtml}</td>
        </tr>
      `;
    } else {
      return `
        <tr>
          <td class="text-muted text-sm font-mono">${formatDate(t.createdAt)}</td>
          <td><span class="group-type-badge">${escapeHtml(t.groupName)}</span></td>
          <td><strong>${escapeHtml(t.description)}</strong></td>
          <td class="text-sm">${escapeHtml(typeDisplay)}</td>
          <td class="font-mono font-medium">₹${t.amountRupees}</td>
          <td>${netHtml}</td>
          <td>${statusBadge}</td>
          <td>${actionsHtml}</td>
        </tr>
      `;
    }
  }).join('');

  // Render pagination controls
  renderPagination(paginationBarId, pagination, isGroupView);
}

function renderPagination(containerId, pagination, isGroupView) {
  const container = document.getElementById(containerId);
  if (!container || !pagination) return;

  const { page, totalPages, totalCount } = pagination;
  if (totalPages <= 1) {
    container.innerHTML = `<span>Total: ${totalCount} records</span>`;
    return;
  }

  container.innerHTML = `
    <span>Showing page ${page} of ${totalPages} (${totalCount} records)</span>
    <div class="pagination-controls">
      <button class="btn btn-secondary btn-xs" ${page <= 1 ? 'disabled' : ''} onclick="changePage(${page - 1}, ${isGroupView})">
        Previous
      </button>
      <button class="btn btn-secondary btn-xs" ${page >= totalPages ? 'disabled' : ''} onclick="changePage(${page + 1}, ${isGroupView})">
        Next
      </button>
    </div>
  `;
}

function changePage(newPage, isGroupView) {
  if (isGroupView) {
    groupTxPage = newPage;
    loadGroupTransactions();
  } else {
    globalTxPage = newPage;
    loadGlobalTransactions();
  }
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    globalTxPage = 1;
    loadGlobalTransactions();
  }, 250);
}

function debounceGroupSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    groupTxPage = 1;
    loadGroupTransactions();
  }, 250);
}

// -------------------------------------------------------------
// EXPENSE MODAL & ACCURATE SPLITTING CONTROLLER
// -------------------------------------------------------------

function openRecordExpenseModal() {
  document.getElementById('expense-modal-title').textContent = 'Record Expense';
  document.getElementById('expense-edit-id').value = '';
  document.getElementById('exp-description').value = '';
  document.getElementById('exp-amount').value = '';
  document.getElementById('exp-split-type').value = 'EQUAL';
  document.getElementById('expense-error').classList.add('hidden');

  populateExpenseMembers();
  onSplitTypeChange();
  openModal('expense-modal');
}

async function openEditExpenseModal(transactionId) {
  try {
    const tx = await apiFetch(`/expenses/${transactionId}`);
    document.getElementById('expense-modal-title').textContent = 'Edit Expense (Reverses Previous)';
    document.getElementById('expense-edit-id').value = transactionId;
    document.getElementById('exp-description').value = tx.description;
    document.getElementById('exp-amount').value = tx.amount_rupees;
    document.getElementById('exp-split-type').value = tx.split_type || 'EQUAL';
    document.getElementById('expense-error').classList.add('hidden');

    populateExpenseMembers();

    // Set payer
    const payerEntry = tx.entries.find(e => e.entry_type === 'PAYER_CREDIT');
    if (payerEntry) {
      document.getElementById('exp-payer').value = payerEntry.user_id;
    }

    onSplitTypeChange();
    openModal('expense-modal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function populateExpenseMembers() {
  const payerSelect = document.getElementById('exp-payer');
  payerSelect.innerHTML = currentGroupMembers.map(m => `
    <option value="${m.id}" ${m.id === currentUser.id ? 'selected' : ''}>
      ${escapeHtml(m.name)}${m.id === currentUser.id ? ' (You)' : ''}
    </option>
  `).join('');
}

function onSplitTypeChange() {
  const splitType = document.getElementById('exp-split-type').value;
  const listContainer = document.getElementById('split-participants-list');
  const amountVal = parseFloat(document.getElementById('exp-amount').value) || 0;

  listContainer.innerHTML = currentGroupMembers.map(m => {
    let inputField = '';
    if (splitType === 'EQUAL') {
      inputField = `<span class="text-xs text-muted" id="split-eq-val-${m.id}">Included</span>`;
    } else if (splitType === 'EXACT') {
      inputField = `<input type="number" step="0.01" min="0" class="split-input form-input exact-split-input" data-user="${m.id}" placeholder="0.00" oninput="recomputeSplitInputs()">`;
    } else if (splitType === 'PERCENTAGE') {
      inputField = `<input type="number" step="0.01" min="0" max="100" class="split-input form-input pct-split-input" data-user="${m.id}" placeholder="0.0%" oninput="recomputeSplitInputs()">`;
    } else if (splitType === 'SHARES') {
      inputField = `<input type="number" step="1" min="1" value="1" class="split-input form-input share-split-input" data-user="${m.id}" placeholder="1" oninput="recomputeSplitInputs()">`;
    }

    return `
      <div class="split-item">
        <label>
          <input type="checkbox" class="participant-check" data-user="${m.id}" checked onchange="recomputeSplitInputs()">
          <span>${escapeHtml(m.name)}</span>
        </label>
        ${inputField}
      </div>
    `;
  }).join('');

  recomputeSplitInputs();
}

function recomputeSplitInputs() {
  const splitType = document.getElementById('exp-split-type').value;
  const totalAmount = parseFloat(document.getElementById('exp-amount').value) || 0;
  const badge = document.getElementById('split-summary-badge');
  const checkedBoxes = Array.from(document.querySelectorAll('.participant-check:checked'));

  if (splitType === 'EQUAL') {
    const count = checkedBoxes.length;
    if (count > 0 && totalAmount > 0) {
      const approxShare = (totalAmount / count).toFixed(2);
      badge.textContent = `₹${approxShare} each (${count} people)`;
      badge.style.color = 'var(--text-main)';
    } else {
      badge.textContent = `Sum: ₹${totalAmount.toFixed(2)}`;
    }
  } else if (splitType === 'EXACT') {
    let sum = 0;
    document.querySelectorAll('.exact-split-input').forEach(input => {
      sum += parseFloat(input.value) || 0;
    });
    const diff = totalAmount - sum;
    if (Math.abs(diff) < 0.005 && totalAmount > 0) {
      badge.textContent = `Exact Match: ₹${sum.toFixed(2)} / ₹${totalAmount.toFixed(2)}`;
      badge.style.color = 'var(--success)';
    } else {
      const status = diff > 0 ? `Remaining: ₹${diff.toFixed(2)}` : `Over by: ₹${Math.abs(diff).toFixed(2)}`;
      badge.textContent = `${status} (Total: ₹${totalAmount.toFixed(2)})`;
      badge.style.color = 'var(--danger)';
    }
  } else if (splitType === 'PERCENTAGE') {
    let sumPct = 0;
    document.querySelectorAll('.pct-split-input').forEach(input => {
      sumPct += parseFloat(input.value) || 0;
    });
    if (Math.abs(sumPct - 100) < 0.05) {
      badge.textContent = `100% Allocated (Paise rounded)`;
      badge.style.color = 'var(--success)';
    } else {
      badge.textContent = `Sum: ${sumPct.toFixed(1)}% / 100%`;
      badge.style.color = 'var(--danger)';
    }
  } else if (splitType === 'SHARES') {
    let totalShares = 0;
    document.querySelectorAll('.share-split-input').forEach(input => {
      totalShares += parseInt(input.value, 10) || 0;
    });
    badge.textContent = `Total Shares: ${totalShares}`;
    badge.style.color = 'var(--text-main)';
  }
}

async function handleSaveExpense(e) {
  e.preventDefault();
  const editId = document.getElementById('expense-edit-id').value;
  const description = document.getElementById('exp-description').value;
  const amount = parseFloat(document.getElementById('exp-amount').value);
  const paidByUserId = parseInt(document.getElementById('exp-payer').value, 10);
  const splitType = document.getElementById('exp-split-type').value;
  const errorBox = document.getElementById('expense-error');
  const saveBtn = document.getElementById('save-expense-btn');

  errorBox.classList.add('hidden');
  saveBtn.disabled = true;

  try {
    const checkedCheckboxes = Array.from(document.querySelectorAll('.participant-check:checked'));
    if (checkedCheckboxes.length === 0) {
      throw new Error('At least one participant must be selected.');
    }

    let participants = [];

    if (splitType === 'EQUAL') {
      participants = checkedCheckboxes.map(cb => parseInt(cb.getAttribute('data-user'), 10));
    } else if (splitType === 'EXACT') {
      participants = checkedCheckboxes.map(cb => {
        const uid = parseInt(cb.getAttribute('data-user'), 10);
        const input = document.querySelector(`.exact-split-input[data-user="${uid}"]`);
        return {
          userId: uid,
          amount: parseFloat(input ? input.value : 0) || 0,
        };
      });
    } else if (splitType === 'PERCENTAGE') {
      participants = checkedCheckboxes.map(cb => {
        const uid = parseInt(cb.getAttribute('data-user'), 10);
        const input = document.querySelector(`.pct-split-input[data-user="${uid}"]`);
        return {
          userId: uid,
          percentage: parseFloat(input ? input.value : 0) || 0,
        };
      });
    } else if (splitType === 'SHARES') {
      participants = checkedCheckboxes.map(cb => {
        const uid = parseInt(cb.getAttribute('data-user'), 10);
        const input = document.querySelector(`.share-split-input[data-user="${uid}"]`);
        return {
          userId: uid,
          shares: parseInt(input ? input.value : 1, 10) || 1,
        };
      });
    }

    const payload = {
      groupId: currentGroupId,
      description,
      amount,
      splitType,
      paidByUserId,
      participants,
    };

    if (editId) {
      await apiFetch(`/expenses/${editId}`, {
        method: 'PUT',
        body: payload,
      });
      showToast('Expense updated (old version immutably reversed)', 'success');
    } else {
      await apiFetch('/expenses', {
        method: 'POST',
        body: payload,
      });
      showToast('Expense recorded to double-entry ledger!', 'success');
    }

    closeModal('expense-modal');
    loadGroupDetails(currentGroupId);
    loadGroups();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
  }
}

async function deleteExpense(transactionId) {
  if (!confirm('Are you sure you want to reverse/delete this expense? An immutable reversing ledger entry will be posted.')) {
    return;
  }

  try {
    await apiFetch(`/expenses/${transactionId}`, {
      method: 'DELETE',
      body: { reason: 'Deleted by user' },
    });
    showToast('Expense reversed and removed from active balances.', 'success');
    if (currentGroupId) {
      loadGroupDetails(currentGroupId);
    } else {
      loadGlobalOverview();
    }
    loadGroups();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// SETTLEMENT CONTROLLER (IDEMPOTENT)
// -------------------------------------------------------------

function generateNewIdempotencyKey() {
  const key = `idem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  document.getElementById('settle-idempotency-key').value = key;
  return key;
}

function openRecordSettlementModal() {
  generateNewIdempotencyKey();
  document.getElementById('settle-amount').value = '';
  document.getElementById('settle-notes').value = '';
  document.getElementById('settle-error').classList.add('hidden');

  const fromSelect = document.getElementById('settle-from-user');
  const toSelect = document.getElementById('settle-to-user');

  const options = currentGroupMembers.map(m => `
    <option value="${m.id}">${escapeHtml(m.name)}${m.id === currentUser.id ? ' (You)' : ''}</option>
  `).join('');

  fromSelect.innerHTML = options;
  toSelect.innerHTML = options;

  // Default: current user pays someone or receives
  fromSelect.value = currentUser.id;
  if (currentGroupMembers.length > 1) {
    const other = currentGroupMembers.find(m => m.id !== currentUser.id);
    if (other) toSelect.value = other.id;
  }

  openModal('settlement-modal');
}

function quickSettle(fromUserId, toUserId, amountRupees) {
  openRecordSettlementModal();
  document.getElementById('settle-from-user').value = fromUserId;
  document.getElementById('settle-to-user').value = toUserId;
  document.getElementById('settle-amount').value = amountRupees;
  document.getElementById('settle-notes').value = 'Settled via debt simplification';
}

async function handleSaveSettlement(e) {
  e.preventDefault();
  const fromUserId = parseInt(document.getElementById('settle-from-user').value, 10);
  const toUserId = parseInt(document.getElementById('settle-to-user').value, 10);
  const amount = parseFloat(document.getElementById('settle-amount').value);
  const notes = document.getElementById('settle-notes').value;
  const idempotencyKey = document.getElementById('settle-idempotency-key').value;
  const errorBox = document.getElementById('settle-error');

  if (fromUserId === toUserId) {
    errorBox.textContent = 'Payer and payee cannot be the same person.';
    errorBox.classList.remove('hidden');
    return;
  }

  try {
    await apiFetch('/settlements', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: {
        groupId: currentGroupId,
        fromUserId,
        toUserId,
        amount,
        notes: notes || 'Settlement payment',
      },
    });

    closeModal('settlement-modal');
    showToast('Settlement recorded! Ledgers updated.', 'success');
    if (currentGroupId) {
      loadGroupDetails(currentGroupId);
    } else {
      loadGlobalOverview();
    }
    loadGroups();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  }
}

// -------------------------------------------------------------
// LEDGER INSPECTION MODAL (DOUBLE-ENTRY PROOF)
// -------------------------------------------------------------

async function inspectLedgerEntries(transactionId) {
  try {
    const tx = await apiFetch(`/expenses/${transactionId}`);
    document.getElementById('ledger-tx-title').textContent = `Transaction #${tx.id} — ${tx.description} (${tx.type})`;

    const tbody = document.getElementById('ledger-entries-tbody');
    let totalPaise = 0;

    tbody.innerHTML = tx.entries.map(e => {
      totalPaise += e.amount_paise;
      const isPositive = e.amount_paise > 0;
      const sign = isPositive ? '+' : '';
      const amountClass = isPositive ? 'text-success' : 'text-danger';

      return `
        <tr>
          <td class="font-mono text-muted text-xs">#${e.id}</td>
          <td><strong>${escapeHtml(e.user_name)}</strong></td>
          <td><span class="badge-neutral font-mono text-xs">${escapeHtml(e.entry_type)}</span></td>
          <td class="font-mono font-medium ${amountClass}">${sign}₹${e.amount_rupees}</td>
          <td class="font-mono text-muted text-xs">${sign}${e.amount_paise} p</td>
        </tr>
      `;
    }).join('');

    document.getElementById('ledger-net-sum').textContent = `₹${(totalPaise / 100).toFixed(2)}`;
    document.getElementById('ledger-net-paise').textContent = `${totalPaise} paise`;

    const reversalBox = document.getElementById('ledger-reversal-info');
    if (tx.is_reversed) {
      reversalBox.classList.remove('hidden');
      document.getElementById('ledger-reversal-text').textContent = `⚠️ This transaction has been reversed. It remains in history for audit compliance, but its balance effect is canceled.`;
    } else if (tx.type === 'REVERSAL') {
      reversalBox.classList.remove('hidden');
      document.getElementById('ledger-reversal-text').textContent = `ℹ️ This is an immutable reversing transaction (reversing #${tx.reversal_of_id}).`;
    } else {
      reversalBox.classList.add('hidden');
    }

    openModal('ledger-modal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// CSV EXPORT CONTROLLER
// -------------------------------------------------------------

function exportCsv(groupId = null) {
  const token = authToken;
  const url = `${API_BASE}/export/csv${groupId ? `?groupId=${groupId}` : ''}${groupId ? '&' : '?'}token=${token}`;
  
  // Create hidden link and click to trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = groupId ? `split_ledger_group_${groupId}.csv` : 'split_ledger_all.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Downloading CSV export...', 'info');
}

// -------------------------------------------------------------
// MODAL CONTROLS & UTILITIES
// -------------------------------------------------------------

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Close modal when clicking on backdrop
window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.add('hidden');
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-IN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return isoStr;
  }
}
