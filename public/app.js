(() => {
  const API = '/api/v1';
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  const $ = (id) => document.getElementById(id);
  let currentUser = null;
  let mode = 'login';

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    [].concat(children).forEach((child) => {
      if (child !== null && child !== undefined) {
        node.append(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    });
    return node;
  }

  function toCents(value) {
    const [whole, frac = ''] = String(value).replace('-', '').split('.');
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
    return String(value).startsWith('-') ? -cents : cents;
  }

  function money(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
  }

  function formatDate(value) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body.error?.code === 'UNAUTHENTICATED' && currentUser) {
      signedOut();
    }
    if (!res.ok) {
      const error = new Error(body.error?.message || `Request failed (${res.status})`);
      error.code = body.error?.code;
      error.details = body.error?.details;
      throw error;
    }
    return body;
  }

  function friendlyError(err) {
    switch (err.code) {
      case 'INVALID_CREDENTIALS':
        return 'Email or password is incorrect.';
      case 'EMAIL_EXISTS':
        return 'An account with this email already exists. Log in instead.';
      case 'TOO_MANY_ATTEMPTS':
        return 'Too many failed attempts. Please wait a few minutes and try again.';
      case 'UNAUTHENTICATED':
        return 'Please log in again.';
      case 'DUPLICATE_STATEMENT':
        return 'This bill has already been uploaded.';
      case 'INSUFFICIENT_CREDITS':
        return `Not enough credits. This payment needs ${money(toCents(err.details.required))}, `
          + `you have ${money(toCents(err.details.available))} (short by ${money(toCents(err.details.shortfall))}).`;
      case 'OCR_EXTRACTION_FAILED': {
        const names = {
          payeeName: 'who the bill is from', accountNumberMasked: 'the account number', grossAmount: 'the amount due', dueDate: 'the due date',
        };
        const missing = (err.details?.missing || []).map((f) => names[f] || f).join(', ');
        return `We couldn't read ${missing || 'this bill'}. Try a clearer photo or scan.`;
      }
      case 'UNSUPPORTED_MEDIA_TYPE':
        return 'That file type is not supported. Please upload a PNG, JPG, or other image of your bill.';
      case 'PAYLOAD_TOO_LARGE':
        return 'That file is too large. Please upload a file under 10 MB.';
      case 'ALREADY_SETTLED':
        return 'This bill has already been paid.';
      default:
        return err.message || 'Something went wrong. Please try again.';
    }
  }

  function showView(signedIn) {
    $('sign-in').hidden = signedIn;
    $('dashboard').hidden = !signedIn;
    $('account').hidden = !signedIn;
    if (signedIn) $('account-email').textContent = currentUser.email;
  }

  function setMode(next) {
    mode = next;
    const register = mode === 'register';
    $('sign-in-button').textContent = register ? 'Create account' : 'Log in';
    $('mode-prompt').textContent = register ? 'Already have an account?' : 'New to Necessify?';
    $('mode-toggle').textContent = register ? 'Log in' : 'Create an account';
    $('password').autocomplete = register ? 'new-password' : 'current-password';
    $('sign-in-error').textContent = '';
  }

  async function signIn(email, password) {
    const { user } = await api(mode === 'register' ? '/auth/register' : '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return user;
  }

  function signedOut() {
    currentUser = null;
    $('upload-result').replaceChildren();
    $('sign-in-form').reset();
    showView(false);
  }

  function renderWallet(wallet, entries) {
    $('balance').textContent = money(toCents(wallet.credit_balance)).replace('$', '');
    const tbody = $('activity').querySelector('tbody');
    tbody.replaceChildren();
    $('activity').hidden = entries.length === 0;
    $('activity-empty').hidden = entries.length > 0;
    const labels = {
      CREDIT_ISSUANCE: 'Bill credits added',
      FEE_CREDIT_ISSUANCE: 'Fee credits added',
      SETTLEMENT_PAYMENT: 'Bill paid',
      PLATFORM_FEE: 'Platform fee',
    };
    entries.forEach((entry) => {
      const cents = toCents(entry.amount);
      tbody.append(el('tr', {}, [
        el('td', { text: formatDate(entry.created_at) }),
        el('td', { text: labels[entry.entry_type] || entry.entry_type }),
        el('td', { text: entry.description || '' }),
        el('td', { className: `num ${cents < 0 ? 'negative' : 'positive'}`, text: `${cents > 0 ? '+' : ''}${money(cents)}` }),
        el('td', { className: 'num', text: money(toCents(entry.balance_after)) }),
      ]));
    });
  }

  function paymentBreakdown(statement) {
    const billCents = toCents(statement.gross_amount);
    const feeCents = toCents(statement.platform_fee);
    const feePercent = Number((Number(statement.platform_fee_rate) * 100).toFixed(4));
    return { billCents, feeCents, feePercent, totalCents: billCents + feeCents };
  }

  function renderBills(statements) {
    const list = $('bills');
    list.replaceChildren();
    $('bills-empty').hidden = statements.length > 0;

    statements.forEach((statement) => {
      const settled = statement.verification_status === 'settled';
      const item = el('li', { className: 'bill' });
      const message = el('p', { className: 'error', role: 'alert' });
      const payButton = settled ? null : el('button', { className: 'primary', type: 'button', text: 'Pay bill' });

      item.append(el('div', { className: 'bill-row' }, [
        el('div', {}, [
          el('div', { className: 'bill-title', text: statement.payee_name }),
          el('div', { className: 'bill-meta', text: `Account ${statement.account_number_masked} · Due ${formatDate(statement.due_date)}` }),
        ]),
        el('div', { className: 'bill-actions' }, [
          el('span', { className: 'bill-amount', text: money(toCents(statement.gross_amount)) }),
          el('span', { className: `badge ${settled ? 'settled' : 'pending'}`, text: settled ? 'Paid' : 'Unpaid' }),
          payButton,
        ]),
      ]));

      if (payButton) {
        payButton.addEventListener('click', () => {
          payButton.hidden = true;
          item.append(renderConfirm(statement, message, () => { payButton.hidden = false; }));
        });
      }
      item.append(message);
      list.append(item);
    });
  }

  function renderConfirm(statement, message, onCancel) {
    const { billCents, feeCents, feePercent, totalCents } = paymentBreakdown(statement);
    const confirmButton = el('button', { className: 'primary', type: 'button', text: `Pay ${money(totalCents)}` });
    const cancelButton = el('button', { className: 'secondary', type: 'button', text: 'Cancel' });
    const panel = el('div', { className: 'confirm' }, [
      el('table', {}, [
        el('tr', {}, [el('td', { text: `${statement.payee_name} receives (100%, $0 fee to them)` }), el('td', { className: 'num', text: money(billCents) })]),
        el('tr', {}, [el('td', { text: `Necessify platform fee (${feePercent}%)` }), el('td', { className: 'num', text: money(feeCents) })]),
        el('tr', { className: 'total' }, [el('td', { text: 'Total from your wallet' }), el('td', { className: 'num', text: money(totalCents) })]),
      ]),
      el('div', { className: 'buttons' }, [confirmButton, cancelButton]),
    ]);

    cancelButton.addEventListener('click', () => {
      panel.remove();
      message.textContent = '';
      onCancel();
    });

    confirmButton.addEventListener('click', async () => {
      confirmButton.disabled = true;
      cancelButton.disabled = true;
      message.textContent = '';
      try {
        await api('/payments/settle', {
          method: 'POST',
          body: JSON.stringify({ statementId: statement.statement_id }),
        });
        await refresh();
      } catch (err) {
        message.textContent = friendlyError(err);
        confirmButton.disabled = false;
        cancelButton.disabled = false;
      }
    });
    return panel;
  }

  async function refresh() {
    const [walletData, statementData] = await Promise.all([
      api(`/users/${currentUser.user_id}/wallet`),
      api(`/users/${currentUser.user_id}/statements`),
    ]);
    renderWallet(walletData.wallet, walletData.ledgerEntries);
    renderBills(statementData.statements);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function mimeTypeFor(file) {
    if (file.type) return file.type;
    if (/\.txt$/i.test(file.name)) return 'text/plain';
    if (/\.json$/i.test(file.name)) return 'application/json';
    return 'application/octet-stream';
  }

  function showUploadResult(ok, content) {
    $('upload-result').replaceChildren(el('div', { className: `notice ${ok ? 'ok' : 'bad'}` }, content));
  }

  async function handleUpload(event) {
    event.preventDefault();
    const file = $('bill-file').files[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showUploadResult(false, 'That file is too large. Please upload a file under 10 MB.');
      return;
    }
    const button = $('upload-button');
    button.disabled = true;
    button.textContent = 'Reading your bill...';
    $('upload-result').replaceChildren();
    try {
      const fileBase64 = await readFileAsBase64(file);
      const { statement, wallet } = await api('/statements/ingest', {
        method: 'POST',
        body: JSON.stringify({ fileBase64, mimeType: mimeTypeFor(file) }),
      });
      const billCents = toCents(statement.gross_amount);
      const feeCents = toCents(statement.platform_fee);
      showUploadResult(true, [
        el('strong', { text: `${money(billCents + feeCents)} in credits added to your wallet.` }),
        el('p', { className: 'muted', text: `${money(billCents)} for the bill plus ${money(feeCents)} to cover the platform fee, so this bill can be paid in full.` }),
        el('dl', {}, [
          el('dt', { text: 'From' }), el('dd', { text: statement.payee_name }),
          el('dt', { text: 'Account' }), el('dd', { text: statement.account_number_masked }),
          el('dt', { text: 'Due' }), el('dd', { text: formatDate(statement.due_date) }),
          el('dt', { text: 'New balance' }), el('dd', { text: money(toCents(wallet.creditBalance)) }),
        ]),
      ]);
      $('upload-form').reset();
      $('file-label').textContent = 'Choose a photo or scan of your bill, or drag it here';
      await refresh();
    } catch (err) {
      showUploadResult(false, friendlyError(err));
    } finally {
      button.disabled = false;
      button.textContent = 'Upload bill';
    }
  }

  function setupDropzone() {
    const zone = $('dropzone');
    const input = $('bill-file');
    input.addEventListener('change', () => {
      $('file-label').textContent = input.files[0] ? input.files[0].name : 'Choose a photo or scan of your bill, or drag it here';
    });
    ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, () => zone.classList.remove('dragging')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        input.dispatchEvent(new Event('change'));
      }
    });
  }

  async function enterDashboard(user) {
    currentUser = user;
    showView(true);
    await refresh();
  }

  function init() {
    setupDropzone();
    $('upload-form').addEventListener('submit', handleUpload);

    $('sign-in-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('sign-in-error').textContent = '';
      const button = $('sign-in-button');
      button.disabled = true;
      try {
        await enterDashboard(await signIn($('email').value.trim(), $('password').value));
      } catch (err) {
        $('sign-in-error').textContent = friendlyError(err);
      } finally {
        button.disabled = false;
      }
    });

    $('mode-toggle').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

    $('sign-out').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      signedOut();
    });

    api('/auth/me')
      .then(({ user }) => enterDashboard(user))
      .catch(() => signedOut());
  }

  init();
})();
