'use strict';

const DB_NAME = 'StoreLedgerOfflineDB';
const STORE_NAME_KEY = 'StoreLedgerStoreName';
const DEFAULT_STORE_NAME = 'StoreLedger';
const DB_VERSION = 1;
const STORES = ['products', 'customers', 'sales', 'payments'];
const UNITS = ['piece', 'bag', 'bags', 'dozen', 'length', 'sheet', 'box', 'roll', 'bottle', 'can', 'kg', 'meter', 'liter', 'pack', 'set', 'pair', 'other'];
const moneyFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
let db;
let activePage = 'dashboard';
let cart = [];
let selectedPhotoData = '';
let scannerStream = null;
let scannerFrame = null;
let scannerTarget = null;
let scannerDetector = null;
let toastTimer = null;
let saleSubmissionInProgress = false;

const $ = id => document.getElementById(id);
const money = n => moneyFmt.format(Number(n || 0));
const num = value => Number(value || 0);
const cents = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const roundQty = value => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const localDateKey = date => { const d = date instanceof Date ? date : new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const dateText = value => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' }); };
const dateOnly = value => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-PH', { dateStyle:'medium' }); };
const escAttr = value => esc(value);
function getStoreName() { return (localStorage.getItem(STORE_NAME_KEY) || DEFAULT_STORE_NAME).trim() || DEFAULT_STORE_NAME; }
function storeFileSlug() { return getStoreName().toLowerCase().replace(/[<>:"/\\|?*\x00-\x1f]/g,'').trim().replace(/\s+/g,'-') || 'store'; }
function applyStoreName() {
  const name=getStoreName();
  document.title=`${name} — Offline`;
  const heading=$('store-name'); if(heading)heading.textContent=name;
  const logo=$('store-logo'); if(logo)logo.alt=`${name} logo`;
  const field=$('store-name-input'); if(field)field.value=name;
}
function saveStoreName(event) {
  event.preventDefault();
  const name=$('store-name-input').value.trim();
  if(!name)return showToast('Enter a store name.');
  if(name.length>60)return showToast('Store name must be 60 characters or fewer.');
  localStorage.setItem(STORE_NAME_KEY,name);
  applyStoreName();
  showToast('Store name saved.');
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const store of STORES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local database.'));
  });
}
function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Database request failed.'));
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Database transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Database transaction was cancelled.'));
  });
}
async function getAll(store) { return requestPromise(db.transaction(store, 'readonly').objectStore(store).getAll()); }
async function getOne(store, id) { return requestPromise(db.transaction(store, 'readonly').objectStore(store).get(Number(id))); }
async function putOne(store, value) {
  const tx = db.transaction(store, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(store).put(value);
  await done;
}
async function addOne(store, value) {
  const tx = db.transaction(store, 'readwrite');
  const done = transactionDone(tx);
  const request = tx.objectStore(store).add(value);
  const id = await requestPromise(request);
  await done;
  return id;
}
function showToast(message, duration=3000) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}
function setNotice(el, message='', type='info') {
  el.textContent = message;
  el.className = message ? `notice ${type}` : 'notice hidden';
}
function emptyState(title, detail) {
  return `<div class="empty"><div class="empty-icon">▤</div><b>${esc(title)}</b>${esc(detail || '')}</div>`;
}
function statCard(label, value, note, icon) {
  return `<div class="stat"><span class="stat-icon">${icon}</span><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${esc(note || '')}</div></div>`;
}
function unitOptions(selected='', includeNone=false) {
  let html = includeNone ? '<option value="">— None —</option>' : '';
  return html + UNITS.map(u => `<option value="${escAttr(u)}" ${u===selected?'selected':''}>${esc(u)}</option>`).join('');
}
function populateStaticSelects() {
  $('p-unit').innerHTML = unitOptions('piece');
  $('p-alt-unit').innerHTML = unitOptions('', true);
}
function navigate(page) {
  // Update the interface synchronously so navigation still visibly responds before data refreshes.
  const validPages = new Set(['dashboard', 'products', 'sale', 'customers', 'history', 'reports']);
  if (!validPages.has(page)) return;
  const targetView = document.querySelector(`.view[data-view="${page}"]`);
  if (!targetView) {
    console.error(`StoreLedger: missing view for page "${page}".`);
    showToast('This app section could not be found. Reload StoreLedger and try again.');
    return;
  }
  activePage = page;
  document.body.classList.remove('home-launcher');
  document.body.classList.toggle('home-screen', page === 'dashboard');
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    const isActive = btn.dataset.page === page;
    btn.classList.toggle('active', isActive);
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view[data-view]').forEach(view => {
    view.classList.toggle('active', view.dataset.view === page);
  });
  if (db) {
    renderPage(page).catch(err => {
      console.error(`StoreLedger failed to render ${page}:`, err);
      showToast(`Unable to load this page: ${err.message}`);
    });
  }
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); }
}
async function renderPage(page=activePage) {
  if (page === 'dashboard') await renderDashboard();
  if (page === 'products') await renderProducts();
  if (page === 'sale') await renderSalePage();
  if (page === 'customers') await renderCustomers();
  if (page === 'history') await renderHistory();
  if (page === 'reports') await renderReports();
}
async function renderDashboard() {
  const [products, customers, sales] = await Promise.all([getAll('products'), getAll('customers'), getAll('sales')]);
  const todayKey = localDateKey(new Date());
  const todaySales = sales.filter(s => localDateKey(s.date) === todayKey);
  const todayTotal = todaySales.reduce((sum, s) => sum + num(s.total), 0);
  const low = products.filter(p => num(p.stock) <= num(p.lowStock));
  const balances = await customerBalances(customers, sales);
  const outstanding = balances.reduce((sum, c) => sum + c.balance, 0);
  $('dash-stats').innerHTML = [
    statCard('Products', products.length.toLocaleString(), 'Items in your catalogue', '▤'),
    statCard("Today's sales", money(todayTotal), `${todaySales.length} transaction(s)`, '₱'),
    statCard('Low-stock items', low.length.toLocaleString(), 'At or below alert level', '⚠'),
    statCard('Credit outstanding', money(outstanding), 'All customer accounts', '♙')
  ].join('');
  $('dash-low').innerHTML = low.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Stock</th><th>Status</th></tr></thead><tbody>${low.slice(0,8).map(p=>`<tr><td>${esc(p.name)}<div class="muted">${esc(p.code||'')}</div></td><td>${esc(formatQty(p.stock))} ${esc(p.unit)}</td><td><span class="pill ${num(p.stock)<=0?'bad':'low'}">${num(p.stock)<=0?'Out of stock':'Low stock'}</span></td></tr>`).join('')}</tbody></table></div>` : emptyState('Stock levels look good','No products are currently below their alert level.');
  const recent = [...sales].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5);
  $('dash-recent').innerHTML = recent.length ? `<div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Total</th><th>Type</th></tr></thead><tbody>${recent.map(s=>`<tr><td>${esc(s.receiptNo)}<div class="muted">${esc(dateText(s.date))}</div></td><td>${money(s.total)}</td><td><span class="pill ${s.type==='credit'?'low':'good'}">${s.type==='credit'?'Credit':'Cash'}</span></td></tr>`).join('')}</tbody></table></div>` : emptyState('No sales yet','Create a sale to see activity here.');
}
function formatQty(value) { return Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits:3 }); }
function productStatus(p) {
  if (num(p.stock) <= 0) return '<span class="pill bad">Out of stock</span>';
  if (num(p.stock) <= num(p.lowStock)) return '<span class="pill low">Low stock</span>';
  return '<span class="pill good">In stock</span>';
}
function productPhoto(p, size='54px') {
  if (p.photoData) return `<img class="thumb" style="width:${size};height:${size}" src="${escAttr(p.photoData)}" alt="${escAttr(p.name)} photo">`;
  return `<span class="thumb" style="width:${size};height:${size}" aria-label="No photo">${esc((p.name||'?').trim().slice(0,1).toUpperCase() || '?')}</span>`;
}
async function renderProducts() {
  const products = (await getAll('products')).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const search = ($('product-search').value || '').trim().toLowerCase();
  const filter = $('stock-filter').value;
  const shown = products.filter(p => {
    const searchable = [p.name,p.code,p.category,p.supplier].join(' ').toLowerCase();
    if (search && !searchable.includes(search)) return false;
    if (filter==='low' && !(num(p.stock)<=num(p.lowStock))) return false;
    if (filter==='out' && num(p.stock)>0) return false;
    return true;
  });
  $('product-count').textContent = `${shown.length} of ${products.length} product(s)`;
  $('product-table').innerHTML = shown.length ? `<table><thead><tr><th>Product</th><th>SKU / Barcode</th><th>Cost</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>${shown.map(p=>`<tr><td><div class="product-cell">${productPhoto(p)}<div><div class="prod-name">${esc(p.name)}</div><div class="muted">${esc(p.category||'Uncategorised')} · ${esc(p.supplier||'No supplier')}</div></div></div></td><td>${esc(p.code||'—')}</td><td>${money(p.cost)}</td><td>${money(p.price)} <span class="muted">/ ${esc(p.unit)}</span></td><td><b>${esc(formatQty(p.stock))}</b> ${esc(p.unit)}${p.altUnit?`<div class="muted">1 ${esc(p.altUnit)} = ${esc(formatQty(p.altFactor))} ${esc(p.unit)}</div>`:''}</td><td>${productStatus(p)}</td><td><div class="actions"><button class="btn small" data-action="edit-product" data-id="${p.id}">Edit</button><button class="btn small danger" data-action="delete-product" data-id="${p.id}">Delete</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('No matching products','Add a product or change your search/filter.');
}
function resetProductForm() {
  $('product-form').reset(); $('p-id').value=''; $('p-cost').value='0'; $('p-price').value='0'; $('p-stock').value='0'; $('p-low').value='5'; $('p-unit').value='piece'; $('p-alt-unit').value=''; $('p-alt-factor').value='12'; $('p-alt-price').value=''; $('p-code').value=''; selectedPhotoData=''; $('p-photo').value=''; $('photo-preview').classList.add('hidden'); $('product-form-title').textContent='Add a product'; $('save-product-btn').textContent='Save product'; $('product-form-title').closest('.panel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function editProduct(id) {
  const p = await getOne('products', id); if (!p) return showToast('Product not found.');
  $('p-id').value=p.id; $('p-name').value=p.name||''; $('p-code').value=p.code||''; $('p-category').value=p.category||''; $('p-supplier').value=p.supplier||''; $('p-cost').value=num(p.cost); $('p-price').value=num(p.price); $('p-stock').value=num(p.stock); $('p-low').value=num(p.lowStock); $('p-unit').value=p.unit||'piece'; $('p-alt-unit').value=p.altUnit||''; $('p-alt-factor').value=num(p.altFactor)||12; $('p-alt-price').value=p.altPrice ?? ''; selectedPhotoData=p.photoData||''; $('p-photo').value='';
  if (selectedPhotoData) { $('photo-preview-img').src=selectedPhotoData; $('photo-preview').classList.remove('hidden'); } else $('photo-preview').classList.add('hidden');
  $('product-form-title').textContent='Edit product'; $('save-product-btn').textContent='Update product'; $('product-editor').scrollIntoView({behavior:'smooth',block:'start'});
}
async function saveProduct(event) {
  event.preventDefault();
  const id = $('p-id').value ? Number($('p-id').value) : null;
  const name=$('p-name').value.trim();
  const code=$('p-code').value.trim() || `SKU-${Date.now().toString().slice(-8)}`;
  const unit=$('p-unit').value; const altUnit=$('p-alt-unit').value;
  const existing = await getAll('products');
  if (existing.some(p => String(p.code||'').toLowerCase()===code.toLowerCase() && p.id!==id)) return showToast('That barcode/SKU is already used by another product.');
  if (altUnit && altUnit===unit) return showToast('The optional selling unit must differ from the stock unit.');
  const file=$('p-photo').files && $('p-photo').files[0];
  if (file) {
    if (!file.type.startsWith('image/')) return showToast('Please select an image file.');
    if (file.size > 6*1024*1024) return showToast('Photo is larger than 6 MB. Choose a smaller image.');
    try { selectedPhotoData = await fileToDataURL(file); } catch { return showToast('Could not read that photo.'); }
  }
  const p = {
    ...(id ? existing.find(x=>x.id===id) : {}),
    ...(id ? {id} : {}), name, code,
    category:$('p-category').value.trim(), supplier:$('p-supplier').value.trim(),
    cost:cents(num($('p-cost').value)), price:cents(num($('p-price').value)),
    stock:Math.max(0,num($('p-stock').value)), lowStock:Math.max(0,num($('p-low').value)), unit,
    altUnit:altUnit||'', altFactor:altUnit?Math.max(.001,num($('p-alt-factor').value)||1):0,
    altPrice:altUnit && $('p-alt-price').value!=='' ? cents(num($('p-alt-price').value)) : null,
    photoData:selectedPhotoData || (existing.find(x=>x.id===id)?.photoData || ''), updatedAt:new Date().toISOString()
  };
  if (!name) return showToast('Product name is required.');
  if (id) await putOne('products', p); else { p.createdAt=new Date().toISOString(); await addOne('products',p); }
  resetProductForm(); await renderProducts(); await updateSelects(); showToast(id?'Product updated.':'Product saved.');
}
async function deleteProduct(id) {
  const p=await getOne('products',id); if(!p) return;
  const sales=await getAll('sales');
  if(sales.some(s=>(s.lines||[]).some(l=>l.productId===Number(id)))) return showToast('This product appears in sales history. Edit it and set stock to zero instead of deleting it.');
  if(!confirm(`Delete “${p.name}”? This cannot be undone.`)) return;
  const tx=db.transaction('products','readwrite'); const done=transactionDone(tx); tx.objectStore('products').delete(Number(id)); await done;
  await renderProducts(); await updateSelects(); showToast('Product deleted.');
}
function fileToDataURL(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);}); }

async function updateSelects() {
  const products=(await getAll('products')).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const customers=(await getAll('customers')).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const oldProduct=$('sale-product').value;
  $('sale-product').innerHTML = products.length ? products.map(p=>`<option value="${p.id}" ${String(p.id)===oldProduct?'selected':''}>${esc(p.name)} — ${esc(formatQty(p.stock))} ${esc(p.unit)} (${money(p.price)})</option>`).join('') : '<option value="">Add products first</option>';
  const customerOptions = '<option value="">Walk-in / no customer</option>' + customers.map(c=>`<option value="${c.id}">${esc(c.name)}${c.phone?` · ${esc(c.phone)}`:''}</option>`).join('');
  const oldSaleCustomer=$('sale-customer').value;
  $('sale-customer').innerHTML=customerOptions;
  if ([...$('sale-customer').options].some(o=>o.value===oldSaleCustomer)) $('sale-customer').value=oldSaleCustomer;
  const oldPayCustomer=$('payment-customer').value;
  $('payment-customer').innerHTML='<option value="">Select customer…</option>'+customers.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if ([...$('payment-customer').options].some(o=>o.value===oldPayCustomer)) $('payment-customer').value=oldPayCustomer;
  refreshSaleUnitOptions();
}
async function renderSalePage() { await updateSelects(); renderCart(); updateCheckoutNotice(); }
async function refreshSaleUnitOptions() {
  const p=await getOne('products',$('sale-product').value);
  if(!p){$('sale-unit').innerHTML='<option value="">—</option>';$('sale-unit-price').value='0';return;}
  $('sale-unit').innerHTML=`<option value="base">${esc(p.unit)}</option>`+(p.altUnit?`<option value="alt">${esc(p.altUnit)}</option>`:'');
  setSalePriceFromUnit();
}
async function setSalePriceFromUnit() {
  const p=await getOne('products',$('sale-product').value); if(!p)return;
  const alt=$('sale-unit').value==='alt';
  $('sale-unit-price').value = alt ? (p.altPrice===null || p.altPrice===undefined || p.altPrice==='' ? cents(num(p.price)*num(p.altFactor)) : num(p.altPrice)) : num(p.price);
}
function cartTotal() { return cents(cart.reduce((sum,line)=>sum+cents(num(line.qty)*num(line.unitPrice)),0)); }
async function addCartProduct(product) {
  const qty=num($('sale-qty').value);
  if(!(qty>0)) return showToast('Enter a quantity greater than zero.');
  const sellingAlt=$('sale-unit').value==='alt';
  const factor=sellingAlt?num(product.altFactor):1;
  const unit=sellingAlt?product.altUnit:product.unit;
  const unitPrice=num($('sale-unit-price').value);
  const stockNeeded=qty*factor;
  const alreadyInCart=cart.filter(l=>l.productId===product.id).reduce((sum,l)=>sum+l.qty*l.factor,0);
  if(stockNeeded+alreadyInCart>num(product.stock)+1e-9) return showToast(`Not enough stock. Available: ${formatQty(Math.max(0,num(product.stock)-alreadyInCart))} ${product.unit}.`);
  cart.push({key:`${Date.now()}-${Math.random().toString(16).slice(2,7)}`,productId:product.id,name:product.name,code:product.code,qty,factor,unit,baseUnit:product.unit,unitPrice:cents(unitPrice),cost:num(product.cost),stockQty:stockNeeded});
  $('sale-qty').value='1'; renderCart(); updateCheckoutNotice();
}
async function addByBarcode(code) {
  const barcode=String(code||'').trim(); if(!barcode)return;
  const products=await getAll('products'); const product=products.find(p=>String(p.code||'').toLowerCase()===barcode.toLowerCase());
  if(!product) { showToast('No product matches that barcode/SKU.'); return false; }
  $('sale-product').value=String(product.id); await refreshSaleUnitOptions();
  if(num(product.stock)<=0) { showToast('This product is out of stock.'); return false; }
  await addCartProduct(product); $('sale-barcode').value=''; return true;
}
function renderCart() {
  if ($('sale-type')?.value === 'cash') $('sale-paid').value = cartTotal();
  $('cart-count').textContent=`${cart.length} line item(s)`;
  $('cart-total').textContent=money(cartTotal());
  if(!cart.length){$('cart-lines').innerHTML=emptyState('Your cart is empty','Add products to start a sale.');updateCheckoutNotice();return;}
  $('cart-lines').innerHTML=cart.map(line=>`<div class="cart-line"><div><div class="cart-name">${esc(line.name)}</div><div class="muted">${esc(line.unit)} · ${money(line.unitPrice)} each</div></div><input aria-label="Quantity of ${escAttr(line.name)}" type="number" min="0.001" step="0.001" value="${escAttr(line.qty)}" data-cart-qty="${escAttr(line.key)}"><input aria-label="Unit price for ${escAttr(line.name)}" type="number" min="0" step="0.01" value="${escAttr(line.unitPrice)}" data-cart-price="${escAttr(line.key)}"><button class="cart-remove" type="button" data-action="remove-cart" data-id="${escAttr(line.key)}" aria-label="Remove ${escAttr(line.name)}">×</button><div class="muted" style="grid-column:1/-1;text-align:right">Line total: <b>${money(line.qty*line.unitPrice)}</b> · deducts ${esc(formatQty(line.qty*line.factor))} ${esc(line.baseUnit)}</div></div>`).join('');
  updateCheckoutNotice();
}
function updateCheckoutNotice() {
  if(!$('checkout-notice'))return;
  const total=cartTotal(); const type=$('sale-type').value; const paid=num($('sale-paid').value); const customerId=$('sale-customer').value;
  if(!cart.length) return setNotice($('checkout-notice'),'Add at least one item to the transaction.','info');
  if(type==='credit'&&!customerId) return setNotice($('checkout-notice'),'Select a customer for every credit sale.','error');
  if(type==='cash'&&paid<total) return setNotice($('checkout-notice'),`Cash sale requires at least ${money(total)} received. Any excess is change.`,'error');
  if(type==='credit') return setNotice($('checkout-notice'),`Total ${money(total)} · Received ${money(paid)} · New balance ${money(Math.max(0,total-paid))}`,'info');
  return setNotice($('checkout-notice'),`Change: ${money(Math.max(0,paid-total))}`,'success');
}
async function completeSale(event) {
  event.preventDefault();
  if(saleSubmissionInProgress)return;
  saleSubmissionInProgress=true;
  const submitButton=$('checkout-form').querySelector('button[type="submit"]');
  submitButton.disabled=true;
  try {
  if(!cart.length)return showToast('Add at least one product.');
  const type=$('sale-type').value; const customerId=$('sale-customer').value?Number($('sale-customer').value):null; const total=cartTotal(); const received=cents(num($('sale-paid').value));
  if(type==='credit'&&!customerId)return showToast('A customer is required for a credit sale.');
  if(type==='credit'&&!(await getOne('customers',customerId)))return showToast('Selected customer was not found.');
  if(received<0)return showToast('Amount received cannot be negative.');
  if(type==='cash'&&received<total)return showToast('Cash received must cover the full sale total.');
  if(type==='credit'&&received>total)return showToast('For a credit sale, amount received cannot exceed the sale total.');
  const products=await getAll('products'); const productMap=new Map(products.map(p=>[p.id,p])); const required=new Map();
  for(const line of cart)required.set(line.productId,(required.get(line.productId)||0)+line.qty*line.factor);
  for(const [pid,needed] of required){const p=productMap.get(pid);if(!p||num(p.stock)+1e-9<needed)return showToast(`Stock changed for ${p?.name||'a product'}. Review the cart before checkout.`);}
  const now=new Date().toISOString();
  const lines=cart.map(line=>({productId:line.productId,name:line.name,code:line.code,qty:num(line.qty),unit:line.unit,factor:num(line.factor),baseUnit:line.baseUnit,stockQty:num(line.qty)*num(line.factor),unitPrice:cents(line.unitPrice),cost:cents(line.cost),lineTotal:cents(line.qty*line.unitPrice)}));
  const paidAmount=type==='cash'?total:received;
  const stockChanges=[...required].map(([productId,needed])=>{const product=productMap.get(productId);const stockBefore=num(product.stock);const stockAfter=roundQty(Math.max(0,stockBefore-needed));return {productId,productName:product.name,stockUnit:product.unit,stockBefore,stockAfter,soldOut:stockBefore>0&&stockAfter===0};});
  const customer=customerId?await getOne('customers',customerId):null;
  const sale={receiptNo:`SL-${localDateKey(new Date()).replaceAll('-','')}-${Date.now()}-${crypto.randomUUID().slice(0,8)}`,date:now,type,customerId,customerName:customer?.name||'Walk-in',lines,subtotal:total,total,paidAmount,balanceDue:cents(total-paidAmount),cashReceived:type==='cash'?received:null,change:type==='cash'?cents(Math.max(0,received-total)):0,stockChanges};
  try {
    const tx=db.transaction(['products','sales'],'readwrite');
    const done=transactionDone(tx);
    for(const [pid,needed] of required){const p=productMap.get(pid);tx.objectStore('products').put({...p,stock:roundQty(Math.max(0,num(p.stock)-needed)),updatedAt:now});}
    tx.objectStore('sales').add(sale);
    await done;
  } catch(err) { console.error(err); return showToast('Sale was not saved. Please try again.'); }
  cart=[]; $('sale-barcode').value=''; $('sale-paid').value='0'; $('sale-type').value='cash'; $('sale-customer').value='';
  await updateSelects(); renderCart(); await renderDashboard(); await renderProducts(); await renderCustomers();
  try { const png=await createSaleReceiptPng(sale); downloadFile(`${sale.receiptNo}-receipt.png`,png,'image/png'); showToast(`Sale ${sale.receiptNo} saved. Receipt PNG downloaded.`); }
  catch(err) { console.error('Receipt PNG generation failed:',err); showToast(`Sale ${sale.receiptNo} saved, but its receipt image could not be generated. Use Sales History to retry.`); }
  } finally { saleSubmissionInProgress = false; submitButton.disabled = false; }
}

async function customerBalances(customersArg=null,salesArg=null) {
  const customers=customersArg || await getAll('customers'); const sales=salesArg || await getAll('sales');
  return customers.map(c=>{
    const unpaidSales=sales.filter(s=>s.customerId===c.id).reduce((sum,s)=>sum+num(s.balanceDue),0);
    return {...c,balance:cents(num(c.openingBalanceRemaining)+unpaidSales),unpaidSales:cents(unpaidSales)};
  });
}
function resetCustomerForm() {
  $('customer-form').reset();$('c-id').value='';$('c-opening').disabled=false;$('c-opening').value='0';$('customer-form-title').textContent='Add a customer';
}
async function saveCustomer(event) {
  event.preventDefault(); const id=$('c-id').value?Number($('c-id').value):null;const name=$('c-name').value.trim();
  if(!name)return showToast('Customer name is required.');
  const c={name,phone:$('c-phone').value.trim(),notes:$('c-notes').value.trim(),updatedAt:new Date().toISOString()};
  if(id){const old=await getOne('customers',id);if(!old)return showToast('Customer not found.');await putOne('customers',{...old,...c,id});showToast('Customer updated.');}
  else {c.openingBalance=cents(num($('c-opening').value)); c.openingBalanceRemaining=c.openingBalance;c.createdAt=new Date().toISOString();await addOne('customers',c);showToast('Customer saved.');}
  resetCustomerForm();await renderCustomers();await updateSelects();
}
async function editCustomer(id) {
  const c=await getOne('customers',id);if(!c)return;
  $('c-id').value=c.id;$('c-name').value=c.name||'';$('c-phone').value=c.phone||'';$('c-notes').value=c.notes||'';$('c-opening').value=num(c.openingBalance);$('c-opening').disabled=true;$('customer-form-title').textContent='Edit customer';$('customer-form').scrollIntoView({behavior:'smooth',block:'start'});
}
async function renderCustomerRecordHistory(customerId) {
  const [customer,sales,payments]=await Promise.all([getOne('customers',customerId),getAll('sales'),getAll('payments')]);
  const host=$('customer-record-history'); if(!customer||!host)return;
  const entries=[];
  if(num(customer.openingBalance)>0) entries.push({date:customer.createdAt||'',kind:'Opening balance',detail:'Old unsettled balance',amount:num(customer.openingBalance),balance:num(customer.openingBalance)});
  sales.filter(s=>s.customerId===customerId).forEach(s=>entries.push({date:s.date,kind:s.type==='credit'?'Credit sale':'Cash sale',detail:`${s.receiptNo} · ${(s.lines||[]).map(l=>l.name).join(', ')}`,amount:num(s.total),paid:num(s.paidAmount),balance:num(s.balanceDue)}));
  payments.filter(p=>p.customerId===customerId).forEach(p=>entries.push({date:p.date,kind:'Payment',detail:p.note||'Customer payment',amount:-num(p.amount),balance:null}));
  entries.sort((a,b)=>new Date(b.date)-new Date(a.date));
  host.innerHTML=`<h4>${esc(customer.name)} · Record history</h4>`+(entries.length?`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Record</th><th>Details</th><th>Amount</th><th>Balance due</th></tr></thead><tbody>${entries.map(e=>`<tr><td>${esc(dateText(e.date))}</td><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td><td>${money(e.amount)}</td><td>${e.balance===null?'—':money(e.balance)}</td></tr>`).join('')}</tbody></table></div>` :emptyState('No customer activity','This customer has no recorded sales or payments yet.'));
}
async function addQuickCustomer(event) {
  event.preventDefault(); const name=$('quick-customer-name').value.trim();
  if(!name)return showToast('Customer name is required.');
  const opening=cents(num($('quick-customer-opening').value));
  try {
    const id=await addOne('customers',{name,phone:$('quick-customer-phone').value.trim(),notes:'',openingBalance:opening,openingBalanceRemaining:opening,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    $('quick-customer-modal').classList.remove('show');$('quick-customer-form').reset();$('quick-customer-opening').value='0';
    await updateSelects();$('sale-customer').value=String(id);await renderCustomers();updateCheckoutNotice();showToast('Customer saved and selected for this sale.');
  } catch(err) { console.error(err);showToast('Customer was not saved. Try again.'); }
}
async function deleteAllAppData() {
  if(!confirm('Delete ALL products, customers, sales and payments saved in this browser? This cannot be undone.'))return;
  try { const tx=db.transaction(STORES,'readwrite');const done=transactionDone(tx);for(const store of STORES)tx.objectStore(store).clear();await done; }
  catch(err) { console.error(err);return showToast('App data could not be deleted.'); }
  cart=[];resetProductForm();resetCustomerForm();$('quick-customer-form').reset();$('quick-customer-modal').classList.remove('show');
  $('customer-record-history').innerHTML=emptyState('No customer selected','Choose History beside a customer to review activity.');
  await renderAll();showToast('All app data was deleted from this browser.');
}async function renderCustomers() {
  const [customers,sales,payments]=await Promise.all([getAll('customers'),getAll('sales'),getAll('payments')]);
  const balances=await customerBalances(customers,sales);const search=($('customer-search').value||'').trim().toLowerCase();const shown=balances.filter(c=>[c.name,c.phone,c.notes].join(' ').toLowerCase().includes(search)).sort((a,b)=>a.name.localeCompare(b.name));
  $('customer-table').innerHTML=shown.length?`<table><thead><tr><th>Customer</th><th>Opening balance left</th><th>Unpaid sales</th><th>Total outstanding</th><th>Actions</th></tr></thead><tbody>${shown.map(c=>`<tr><td><b>${esc(c.name)}</b><div class="muted">${esc(c.phone||'No contact')}</div></td><td>${money(c.openingBalanceRemaining)}</td><td>${money(c.unpaidSales)}</td><td><b>${money(c.balance)}</b></td><td><div class="actions"><button class="btn small" data-action="edit-customer" data-id="${c.id}">Edit</button><button class="btn small soft" data-action="pay-customer" data-id="${c.id}">Record payment</button><button class="btn small" data-action="customer-history" data-id="${c.id}">History</button></div></td></tr>`).join('')}</tbody></table>`:emptyState('No customers found','Add a customer to record credit purchases and payments.');
  const dueTotal=balances.reduce((sum,c)=>sum+c.balance,0);
  $('payment-form').querySelector('button[type="submit"]').disabled=!customers.length||dueTotal<=0;
  const history=$('payment-history'); if(history){const recent=[...payments].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,8);history.innerHTML=recent.length?`<div class="table-wrap"><table><thead><tr><th>Payment date</th><th>Customer</th><th>Amount</th><th>Note</th></tr></thead><tbody>${recent.map(p=>`<tr><td>${esc(dateText(p.date))}</td><td>${esc(p.customerName)}</td><td>${money(p.amount)}</td><td>${esc(p.note||'—')}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No payments recorded','Customer payments will appear here.');}
}
async function recordPayment(event) {
  event.preventDefault();const customerId=Number($('payment-customer').value);const amount=cents(num($('payment-amount').value));const note=$('payment-note').value.trim();
  if(!customerId)return showToast('Select a customer.');if(!(amount>0))return showToast('Enter a payment greater than zero.');
  const [customer,sales]=await Promise.all([getOne('customers',customerId),getAll('sales')]);if(!customer)return showToast('Customer was not found.');
  let remaining=amount;const allocation=[];let openingLeft=num(customer.openingBalanceRemaining);
  const oldPart=Math.min(openingLeft,remaining);if(oldPart>0){openingLeft=cents(openingLeft-oldPart);remaining=cents(remaining-oldPart);allocation.push({kind:'opening',amount:oldPart});}
  const unpaid=sales.filter(s=>s.customerId===customerId&&num(s.balanceDue)>0).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const updates=[];
  for(const sale of unpaid){if(remaining<=0)break;const part=Math.min(num(sale.balanceDue),remaining);if(part>0){const updated={...sale,balanceDue:cents(num(sale.balanceDue)-part),paidAmount:cents(num(sale.paidAmount)+part)};updates.push(updated);allocation.push({kind:'sale',receiptNo:sale.receiptNo,saleId:sale.id,amount:part});remaining=cents(remaining-part);}}
  if(remaining>0.001)return showToast(`Payment exceeds this customer's outstanding balance by ${money(remaining)}.`);
  const payment={customerId,customerName:customer.name,amount,note,date:new Date().toISOString(),allocation};
  try{const tx=db.transaction(['customers','sales','payments'],'readwrite');const done=transactionDone(tx);tx.objectStore('customers').put({...customer,openingBalanceRemaining:openingLeft,updatedAt:new Date().toISOString()});updates.forEach(s=>tx.objectStore('sales').put(s));tx.objectStore('payments').add(payment);await done;}catch(err){console.error(err);return showToast('Payment was not saved. Try again.');}
  $('payment-amount').value='';$('payment-note').value='';await renderCustomers();await renderDashboard();await renderHistory();await renderReports();showToast(`Payment of ${money(amount)} recorded.`);
}
function isAndroidInstalledApp() {
  const isAndroid=/Android/i.test(navigator.userAgent||'');
  const isInstalled=window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone===true;
  return isAndroid&&Boolean(isInstalled);
}function filteredHistorySales(sales) {
  const search=($('history-search').value||'').trim().toLowerCase(), type=$('history-type').value;
  return [...sales].sort((a,b)=>new Date(b.date)-new Date(a.date)).filter(s=>{
    if(type!=='all'&&s.type!==type)return false;
    const lines=(s.lines||[]).map(l=>l.name+' '+l.code).join(' ');
    return !search||[s.receiptNo,s.customerName,lines].join(' ').toLowerCase().includes(search);
  });
}async function renderHistory() {
  const [sales,customers]=await Promise.all([getAll('sales'),getAll('customers')]);const customerMap=new Map(customers.map(c=>[c.id,c]));
  const shown=filteredHistorySales(sales);
  $('sales-table').innerHTML=shown.length?`<table><thead><tr><th>Receipt / Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Paid</th><th>Balance due</th><th>Type</th><th>Receipt</th></tr></thead><tbody>${shown.map(s=>`<tr><td><b>${esc(s.receiptNo)}</b><div class="muted">${esc(dateText(s.date))}</div></td><td>${esc(customerMap.get(s.customerId)?.name||s.customerName||'Walk-in')}</td><td>${(s.lines||[]).reduce((n,l)=>n+num(l.qty),0).toLocaleString('en-PH',{maximumFractionDigits:3})} qty<div class="muted">${esc((s.lines||[]).map(l=>l.name).join(', '))}</div></td><td><b>${money(s.total)}</b></td><td>${money(s.paidAmount)}</td><td>${num(s.balanceDue)>0?`<span class="pill low">${money(s.balanceDue)}</span>`:money(0)}</td><td><span class="pill ${s.type==='credit'?'low':'good'}">${s.type==='credit'?'Credit':'Cash'}</span></td><td><div class="actions"><button class="btn small" data-action="image-sale" data-id="${s.id}">Image</button><button class="btn small" data-action="share-sale" data-id="${s.id}">Share</button><button class="btn small" data-action="print-sale" data-id="${s.id}">Print</button></div></td></tr>`).join('')}</tbody></table>`:emptyState('No sales found','Completed transactions will appear here.');
}
async function printReceipt(sale) {
  if(!sale)return;const customer=sale.customerName||'Walk-in';const balances=sale.customerId?await customerBalances():[];const account=balances.find(c=>c.id===sale.customerId);
  const rows=(sale.lines||[]).map(l=>`<tr><td>${esc(l.name)}<br><small>${esc(formatQty(l.qty))} ${esc(l.unit)} × ${money(l.unitPrice)}</small></td><td class="amount">${money(l.lineTotal ?? l.qty*l.unitPrice)}</td></tr>`).join('');
  const acct=account?`<div class="rule"></div><div class="row"><span>Unpaid sales</span><span>${money(account.unpaidSales)}</span></div><div class="row"><span>Old balance remaining</span><span>${money(account.openingBalanceRemaining)}</span></div><div class="row strong"><span>Existing balance</span><span>${money(account.balance)}</span></div>`:'';
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(sale.receiptNo)}</title><style>@page{size:57mm auto;margin:0}*{box-sizing:border-box}body{font:9px Arial;color:#111;margin:0;width:57mm}.receipt{width:57mm;min-height:40mm;padding:3mm}h2,p{text-align:center;margin:2px 0}h2{font-size:12px}table{width:100%;border-collapse:collapse;margin-top:5px}td{padding:3px 0;border-bottom:1px dashed #aaa;vertical-align:top}.amount{text-align:right;white-space:nowrap}.row{display:flex;justify-content:space-between;gap:3px;padding:2px 0}.strong{font-weight:bold}.rule{border-top:1px dashed #555;margin:4px 0}.foot{text-align:center;margin-top:5px;font-size:8px}</style></head><body><div class="receipt"><h2>${esc(getStoreName())}</h2><p>SALES RECEIPT</p><p>${esc(sale.receiptNo)} · ${esc(dateText(sale.date))}</p><p>Customer: ${esc(customer)}</p><table>${rows}</table><div class="row strong"><span>Total</span><span>${money(sale.total)}</span></div><div class="row"><span>Paid on sale</span><span>${money(sale.paidAmount)}</span></div><div class="row"><span>Unpaid on sale</span><span>${money(sale.balanceDue)}</span></div>${sale.type==='cash'?`<div class="row"><span>Cash received</span><span>${money(sale.cashReceived)}</span></div><div class="row"><span>Change</span><span>${money(sale.change)}</span></div>`:''}<div class="row strong"><span>Payment</span><span>${esc(sale.type.toUpperCase())}</span></div>${acct}<p class="foot">Thank you!</p></div><script>window.onload=()=>window.print()<\/script></body></html>`;
  const w=window.open('','_blank','width=360,height=640');if(!w){showToast('Your browser blocked the receipt window. Allow pop-ups and try again.');return;}w.document.open();w.document.write(html);w.document.close();
}
async function createSaleReceiptPng(sale) {
  if(!sale) throw new Error('Sale not found.');
  const width=560, imageHeight=Math.max(430,330+(sale.lines||[]).length*58);
  const rows=(sale.lines||[]).map(l=>'<div class="line"><span>'+esc(l.name)+'<br/><small>'+esc(formatQty(l.qty))+' '+esc(l.unit)+' × '+money(l.unitPrice)+'</small></span><b>'+money(l.lineTotal??l.qty*l.unitPrice)+'</b></div>').join('');
  const payment=sale.type==='cash'?'<div class="line"><span>Payment received</span><span>'+money(sale.cashReceived??sale.paidAmount)+'</span></div><div class="line"><span>Change</span><span>'+money(sale.change)+'</span></div>':'<div class="line"><span>Payment received</span><span>'+money(sale.paidAmount)+'</span></div><div class="line"><span>Change</span><span>'+money(sale.change)+'</span></div>';
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+imageHeight+'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:20px Arial}.receipt{width:'+width+'px;min-height:'+imageHeight+'px;padding:28px;overflow-wrap:anywhere}h2,p{text-align:center;margin:7px 0}h2{font-size:29px}.line{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed #aaa}small{font-size:17px}hr{border:0;border-top:1px dashed #555;margin:13px 0}.bold{font-weight:bold}.foot{text-align:center}</style><div class="receipt"><h2>'+esc(getStoreName())+'</h2><p>SALES RECEIPT</p><p>'+esc(sale.receiptNo)+' · '+esc(dateText(sale.date))+'</p>'+rows+'<hr/><div class="line"><span>Subtotal</span><span>'+money(sale.subtotal??sale.total)+'</span></div><div class="line bold"><span>Total</span><span>'+money(sale.total)+'</span></div>'+payment+'<p class="foot">Thank you!</p></div></div></foreignObject></svg>';
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
  try { const img=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Could not render receipt image.'));image.src=url;});
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=imageHeight;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas is unavailable.');ctx.drawImage(img,0,0,width,imageHeight);
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not encode PNG.')),'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
async function exportSaleReceiptImage(sale) {
  try { const blob=await createSaleReceiptPng(sale);downloadFile(sale.receiptNo+'-receipt.png',blob,'image/png');showToast('Receipt PNG downloaded.'); }
  catch(err) { console.error(err);showToast('Could not create receipt image in this browser.'); }
}
async function shareSaleReceiptImage(sale) {
  if(!sale)return;
  try {
    const blob=await createSaleReceiptPng(sale);const file=new File([blob],sale.receiptNo+'-receipt.png',{type:'image/png'});
    if(navigator.canShare?.({files:[file]})&&navigator.share){await navigator.share({files:[file],title:'Receipt '+sale.receiptNo});}
    else {downloadFile(file.name,blob,'image/png');showToast('Image sharing is unavailable here. Receipt PNG downloaded so you can share it.');}
  } catch(err) { if(err?.name!=='AbortError'){console.error(err);showToast('Could not share receipt image.');} }
}
function csvCell(value) { const s=String(value ?? ''); return `"${s.replace(/"/g,'""')}"`; }
function downloadFile(name, content, type='text/plain;charset=utf-8') {
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function downloadExcel(name, sheets) {
  const escXml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const xml=`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="header"><Font ss:Bold="1"/><Interior ss:Color="#E8F1EB" ss:Pattern="Solid"/></Style></Styles>${sheets.map(sheet=>`<Worksheet ss:Name="${escXml(String(sheet.name).slice(0,31).replace(/[\\/?*\[\]:]/g,' '))}"><Table>${sheet.rows.map((row,index)=>`<Row>${row.map(value=>`<Cell${index===0?' ss:StyleID="header"':''}><Data ss:Type="${typeof value==='number'&&Number.isFinite(value)?'Number':'String'}">${escXml(value)}</Data></Cell>`).join('')}</Row>`).join('')}</Table></Worksheet>`).join('')}</Workbook>`;
  downloadFile(name,xml,'application/vnd.ms-excel;charset=utf-8');
}
function exportProductsCSV(products) {
  const rows=[['ID','Name','Barcode/SKU','Category','Supplier','Cost','Selling price','Stock','Stock unit','Low stock level','Optional unit','Stock units per optional unit','Optional unit price'],...products.map(p=>[p.id,p.name,p.code,p.category,p.supplier,num(p.cost),num(p.price),num(p.stock),p.unit,num(p.lowStock),p.altUnit,num(p.altFactor),p.altPrice===null?'':num(p.altPrice)])];
  downloadExcel(`${storeFileSlug()}-products-${localDateKey(new Date())}.xls`,[{name:'Products',rows}]);
}
function exportSalesCSV(sales) {
  const rows=[['Receipt','Date','Type','Customer','Product','Barcode/SKU','Quantity','Unit','Unit price','Line total','Sale total','Paid','Balance due'],...sales.flatMap(s=>(s.lines||[]).map(l=>[s.receiptNo,s.date,s.type,s.customerName||'Walk-in',l.name,l.code,num(l.qty),l.unit,num(l.unitPrice),num(l.lineTotal??l.qty*l.unitPrice),num(s.total),num(s.paidAmount),num(s.balanceDue)]))];
  downloadExcel(`${storeFileSlug()}-sales-${localDateKey(new Date())}.xls`,[{name:'Sales History',rows}]);
}
async function exportSalesSummaryExcel() {
  const [products,customers,sales,payments]=await Promise.all([getAll('products'),getAll('customers'),getAll('sales'),getAll('payments')]);
  const todayKey=localDateKey(new Date()), monthKey=todayKey.slice(0,7);
  const today=sales.filter(s=>localDateKey(s.date)===todayKey), month=sales.filter(s=>localDateKey(s.date).slice(0,7)===monthKey);
  const outstanding=(await customerBalances(customers,sales)).reduce((sum,c)=>sum+c.balance,0);
  const grossProfit=sales.reduce((sum,s)=>sum+(s.lines||[]).reduce((sum2,l)=>sum2+num(l.lineTotal??l.qty*l.unitPrice)-num(l.cost)*num(l.stockQty??l.qty),0),0);
  const sumByType=type=>sales.filter(s=>s.type===type).reduce((sum,s)=>sum+num(s.total),0);
  const summary=[['Sales Summary','Value'],['Report date',todayKey],['Sales today',today.reduce((sum,s)=>sum+num(s.total),0)],['Transactions today',today.length],['Sales this month',month.reduce((sum,s)=>sum+num(s.total),0)],['Transactions this month',month.length],['Credit outstanding',outstanding],['Estimated gross profit',grossProfit],['All-time sales',sales.reduce((sum,s)=>sum+num(s.total),0)],['Cash sale value',sumByType('cash')],['Credit sale value',sumByType('credit')],['Customer payments recorded',payments.reduce((sum,p)=>sum+num(p.amount),0)],['Products',products.length],['Customers',customers.length],['Gross profit note','Estimated from recorded sale-line costs; excludes overhead and other expenses.']];
  const salesRows=[['Receipt','Date','Type','Customer','Product','Barcode/SKU','Quantity','Unit','Unit price','Line total','Sale total','Paid','Balance due'],...sales.flatMap(s=>(s.lines||[]).map(l=>[s.receiptNo,s.date,s.type,s.customerName||'Walk-in',l.name,l.code,num(l.qty),l.unit,num(l.unitPrice),num(l.lineTotal??l.qty*l.unitPrice),num(s.total),num(s.paidAmount),num(s.balanceDue)]))];
  const paymentRows=[['Date','Customer','Amount','Reference / note'],...payments.map(p=>[p.date,p.customerName||'',num(p.amount),p.note||''])];
  const performanceRows=[['Product','SKU','Date added','Current stock','Unit','Units sold','Sales total','Gross profit','Latest sold-out date'],...productPerformance(products,sales).map(p=>[p.name,p.code,p.createdAt,p.stock,p.unit,p.unitsSold,p.salesTotal,p.grossProfit,p.latestSoldOut])];
  const detailRows=[['Sale date','Receipt','Product','SKU','Date added','Quantity sold','Unit','Sales','Gross profit','Sold out on sale'],...sales.flatMap(s=>(s.lines||[]).map(l=>{const p=products.find(x=>x.id===l.productId);const event=(s.stockChanges||[]).find(x=>x.productId===l.productId&&x.soldOut);const revenue=num(l.lineTotal??num(l.qty)*num(l.unitPrice));return [s.date,s.receiptNo,l.name,l.code,p?.createdAt||'',num(l.qty),l.unit,revenue,cents(revenue-num(l.cost)*num(l.stockQty??num(l.qty)*num(l.factor||1))),event?s.date:''];}))];
  downloadExcel(`${storeFileSlug()}-sales-summary-${todayKey}.xls`,[{name:'Summary',rows:summary},{name:'Product Performance',rows:performanceRows},{name:'Product Sale Detail',rows:detailRows},{name:'Sales Details',rows:salesRows},{name:'Payments',rows:paymentRows}]);
}
async function exportBackup() {
  const [products,customers,sales,payments]=await Promise.all([getAll('products'),getAll('customers'),getAll('sales'),getAll('payments')]);
  const backup={app:'StoreLedger Offline',backupVersion:1,createdAt:new Date().toISOString(),products,customers,sales,payments};
  downloadFile(`${storeFileSlug()}-backup-${localDateKey(new Date())}.json`,JSON.stringify(backup,null,2),'application/json;charset=utf-8');showToast('Backup downloaded. Keep it somewhere safe.');
}
async function restoreBackup(file) {
  if(!file)return;
  if(file.size>50*1024*1024)return showToast('Backup is too large (maximum 50 MB).');
  let data;try{data=JSON.parse(await file.text());}catch{return showToast('This file is not valid JSON.');}
  if(!data||data.app!=='StoreLedger Offline'||!Array.isArray(data.products)||!Array.isArray(data.customers)||!Array.isArray(data.sales)||!Array.isArray(data.payments))return showToast('This is not a valid StoreLedger backup.');
  if(!confirm(`Restore ${data.products.length} products, ${data.customers.length} customers and ${data.sales.length} sales? This will REPLACE all current app data.`))return;
  try{const tx=db.transaction(STORES,'readwrite');const done=transactionDone(tx);for(const store of STORES){const obj=tx.objectStore(store);obj.clear();for(const record of data[store])obj.put(record);}await done;}catch(err){console.error(err);return showToast('Restore failed. Your database may not have changed completely. Check a backup and retry.');}
  cart=[];resetProductForm();resetCustomerForm();await renderAll();showToast('Backup restored successfully.');
}
function productPerformance(products,sales) {
  const rows=new Map(products.map(p=>[p.id,{id:p.id,name:p.name,code:p.code||'',createdAt:p.createdAt||'',stock:num(p.stock),unit:p.unit||'',unitsSold:0,salesTotal:0,grossProfit:0,latestSale:'',latestSoldOut:''}]));
  for(const sale of [...sales].sort((a,b)=>new Date(a.date)-new Date(b.date))) {
    for(const line of sale.lines||[]) {
      const row=rows.get(line.productId); if(!row)continue;
      const stockQty=num(line.stockQty??num(line.qty)*num(line.factor||1));
      const revenue=num(line.lineTotal??num(line.qty)*num(line.unitPrice));
      row.unitsSold+=stockQty; row.salesTotal+=revenue; row.grossProfit+=revenue-num(line.cost)*stockQty;
      if(!row.latestSale||new Date(sale.date)>new Date(row.latestSale))row.latestSale=sale.date;
    }
    for(const event of sale.stockChanges||[])if(event.soldOut&&rows.has(event.productId))rows.get(event.productId).latestSoldOut=sale.date;
  }
  return [...rows.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
async function renderReports() {
  const [products,customers,sales,payments]=await Promise.all([getAll('products'),getAll('customers'),getAll('sales'),getAll('payments')]);
  const todayKey=localDateKey(new Date());const today=sales.filter(s=>localDateKey(s.date)===todayKey);const monthKey=todayKey.slice(0,7);const month=sales.filter(s=>localDateKey(s.date).slice(0,7)===monthKey);
  const outstanding=(await customerBalances(customers,sales)).reduce((sum,c)=>sum+c.balance,0);
  const grossProfit=sales.reduce((sum,s)=>sum+(s.lines||[]).reduce((sum2,l)=>sum2+num(l.lineTotal??l.qty*l.unitPrice)-num(l.cost)*num(l.stockQty??l.qty),0),0);
  $('report-stats').innerHTML=[statCard('Sales today',money(today.reduce((sum,s)=>sum+s.total,0)),`${today.length} transactions`,'₱'),statCard('Sales this month',money(month.reduce((sum,s)=>sum+s.total,0)),`${month.length} transactions`,'▥'),statCard('Credit outstanding',money(outstanding),'Remaining customer balances','♙'),statCard('Estimated gross profit',money(grossProfit),'Before overhead and other expenses','↗')].join('');
  $('sales-summary').innerHTML=`<div class="grid" style="gap:0"><div class="cart-total"><span>All-time sales</span><b>${money(sales.reduce((sum,s)=>sum+num(s.total),0))}</b></div><div class="cart-total"><span>Cash sale value</span><b>${money(sales.filter(s=>s.type==='cash').reduce((sum,s)=>sum+num(s.total),0))}</b></div><div class="cart-total"><span>Credit sale value</span><b>${money(sales.filter(s=>s.type==='credit').reduce((sum,s)=>sum+num(s.total),0))}</b></div><div class="cart-total"><span>Customer payments recorded</span><b>${money(payments.reduce((sum,p)=>sum+num(p.amount),0))}</b></div><div class="cart-total"><span>Products / customers</span><b>${products.length} / ${customers.length}</b></div></div><p class="footnote">Estimated gross profit uses the cost recorded on each sale line. It excludes rent, wages, taxes, damaged stock and other expenses.</p>`;
  renderProductSalesReport(products,sales);
}
function xmlText(value) { return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function svgTable(headers,rows,widths,y) {
  const rowH=38, totalWidth=widths.reduce((a,b)=>a+b,0); let out=`<rect x="40" y="${y}" width="${totalWidth}" height="${rowH}" fill="#e8f1eb"/>`;
  const line=(cells,rowY,bold=false)=>{let x=40;cells.forEach((value,i)=>{const max=Math.max(8,Math.floor((widths[i]-20)/8));const label=String(value??'').length>max?String(value).slice(0,max-1)+'…':String(value??'');out+=`<text x="${x+10}" y="${rowY+25}" font-family="Arial,sans-serif" font-size="15" font-weight="${bold?700:400}" fill="#1b2b22">${xmlText(label)}</text>`;x+=widths[i];});};
  line(headers,y,true);
  rows.forEach((row,index)=>{const yy=y+rowH*(index+1);out+=`<rect x="40" y="${yy}" width="${totalWidth}" height="${rowH}" fill="${index%2?'#ffffff':'#f7f9f7'}"/><path d="M40 ${yy+rowH}H${40+totalWidth}" stroke="#dce4df"/>`;line(row,yy);});
  let x=40; for(const w of widths){x+=w;out+=`<path d="M${x} ${y}V${y+rowH*(rows.length+1)}" stroke="#dce4df"/>`;}
  return {svg:out,height:rowH*(rows.length+1),width:totalWidth};
}
async function exportProductSalesImage() {
  const [products,sales]=await Promise.all([getAll('products'),getAll('sales')]);
  const performance=productPerformance(products,sales);
  const summaryRows=performance.map(p=>[p.name,p.createdAt?dateOnly(p.createdAt):'—',formatQty(p.stock)+' '+p.unit,formatQty(p.unitsSold),money(p.salesTotal),money(p.grossProfit),p.latestSoldOut?dateOnly(p.latestSoldOut):'—']);
  const details=sales.flatMap(s=>(s.lines||[]).map(l=>({sale:s,line:l,stockEvent:(s.stockChanges||[]).find(x=>x.productId===l.productId&&x.soldOut)}))).sort((a,b)=>new Date(b.sale.date)-new Date(a.sale.date));
  const detailRows=details.map(({sale,line,stockEvent})=>{const revenue=num(line.lineTotal??num(line.qty)*num(line.unitPrice));const profit=revenue-num(line.cost)*num(line.stockQty??num(line.qty)*num(line.factor||1));return [dateOnly(sale.date),sale.receiptNo,line.name,formatQty(line.qty)+' '+line.unit,money(revenue),money(profit),stockEvent?'Yes':'—'];});
  const summary=svgTable(['Product','Date added','Current stock','Units sold','Sales','Gross profit','Last sold out'],summaryRows,[300,150,170,130,170,180,160],170);
  const detailY=170+summary.height+70;
  const detail=svgTable(['Sale date','Receipt','Product','Quantity','Sales','Gross profit','Stock-out'],detailRows,[160,190,320,150,180,190,140],detailY);
  const width=Math.max(summary.width,detail.width)+80,height=detailY+detail.height+50;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><text x="40" y="54" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#172d23">${xmlText(getStoreName())} — Product Sales History</text><text x="40" y="91" font-family="Arial,sans-serif" font-size="16" fill="#65736d">Exported ${xmlText(dateText(new Date()))} · Gross profit is estimated from saved sale-line costs.</text><text x="40" y="143" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#172d23">Product summary</text>${summary.svg}<text x="40" y="${detailY-24}" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#172d23">Sale-by-sale details</text>${detail.svg}</svg>`;
  const image=new Image(), url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
  image.onload=()=>{try{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);canvas.toBlob(blob=>{if(blob){downloadFile(`${storeFileSlug()}-product-sales-history-${localDateKey(new Date())}.png`,blob,'image/png');showToast('Product sales history image downloaded.');}else showToast('Could not create the image. Try a smaller report.');},'image/png');}catch(err){console.error(err);showToast('Could not create the image. Try a smaller report.');}finally{URL.revokeObjectURL(url);}};
  image.onerror=()=>{URL.revokeObjectURL(url);showToast('Could not create the image. Try again.');};
  image.src=url;
}async function exportSalesHistoryImage() {
  const [allSales,customers]=await Promise.all([getAll('sales'),getAll('customers')]);
  const sales=filteredHistorySales(allSales), customerMap=new Map(customers.map(c=>[c.id,c]));
  const transactions=sales.map(s=>[s.receiptNo,dateText(s.date),customerMap.get(s.customerId)?.name||s.customerName||'Walk-in',(s.lines||[]).map(l=>l.name).join(', '),money(s.total),money(s.paidAmount),money(s.balanceDue),s.type==='credit'?'Credit':'Cash']);
  const details=sales.flatMap(s=>(s.lines||[]).map(l=>{const revenue=num(l.lineTotal??num(l.qty)*num(l.unitPrice));const profit=revenue-num(l.cost)*num(l.stockQty??num(l.qty)*num(l.factor||1));return [dateText(s.date),s.receiptNo,l.name,formatQty(l.qty)+' '+l.unit,money(l.unitPrice),money(revenue),money(profit)];}));
  const txTable=svgTable(['Receipt','Date','Customer','Items','Total','Paid','Balance','Type'],transactions,[170,190,210,350,150,150,150,110],170);
  const detailY=170+txTable.height+70;
  const detailTable=svgTable(['Sale date','Receipt','Product','Quantity','Unit price','Line total','Gross profit'],details,[190,180,330,150,160,170,190],detailY);
  const width=Math.max(txTable.width,detailTable.width)+80,height=detailY+detailTable.height+50;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><text x="40" y="54" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#172d23">${xmlText(getStoreName())} — Sales History</text><text x="40" y="91" font-family="Arial,sans-serif" font-size="16" fill="#65736d">Exported ${xmlText(dateText(new Date()))} · ${sales.length} transaction(s)</text><text x="40" y="143" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#172d23">Transactions</text>${txTable.svg}<text x="40" y="${detailY-24}" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#172d23">Sale-by-sale product details</text>${detailTable.svg}</svg>`;
  const image=new Image(),url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
  image.onload=()=>{try{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(image,0,0);canvas.toBlob(blob=>{if(blob){downloadFile(`${storeFileSlug()}-sales-history-${localDateKey(new Date())}.png`,blob,'image/png');showToast('Sales history image downloaded.');}else showToast('Could not create the image. Try a smaller report.');},'image/png');}catch(err){console.error(err);showToast('Could not create the image. Try a smaller report.');}finally{URL.revokeObjectURL(url);}};
  image.onerror=()=>{URL.revokeObjectURL(url);showToast('Could not create the image. Try again.');}; image.src=url;
}function renderProductSalesReport(products,sales) {
  const performance=productPerformance(products,sales);
  $('product-sales-report').innerHTML=performance.length?`<div class="table-wrap"><table><thead><tr><th>Product</th><th>Date added</th><th>Current stock</th><th>Units sold</th><th>Sales</th><th>Gross profit</th><th>Last sale</th><th>Last sold out</th></tr></thead><tbody>${performance.map(p=>`<tr><td><b>${esc(p.name)}</b><div class="muted">${esc(p.code||'')}</div></td><td>${esc(p.createdAt?dateOnly(p.createdAt):'—')}</td><td>${esc(formatQty(p.stock))} ${esc(p.unit)}</td><td>${esc(formatQty(p.unitsSold))}</td><td>${money(p.salesTotal)}</td><td>${money(p.grossProfit)}</td><td>${esc(p.latestSale?dateText(p.latestSale):'—')}</td><td>${esc(p.latestSoldOut?dateText(p.latestSoldOut):'—')}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No products yet','Add products to see product sales history.');
  const details=sales.flatMap(s=>(s.lines||[]).map(l=>({sale:s,line:l,stockEvent:(s.stockChanges||[]).find(x=>x.productId===l.productId&&x.soldOut)}))).sort((a,b)=>new Date(b.sale.date)-new Date(a.sale.date));
  $('product-sale-details').innerHTML=details.length?`<div class="table-wrap"><table><thead><tr><th>Sale date</th><th>Receipt</th><th>Product</th><th>Date added</th><th>Quantity</th><th>Sales</th><th>Gross profit</th><th>Stock-out</th></tr></thead><tbody>${details.map(({sale,line,stockEvent})=>{const p=products.find(x=>x.id===line.productId);const revenue=num(line.lineTotal??num(line.qty)*num(line.unitPrice));const profit=revenue-num(line.cost)*num(line.stockQty??num(line.qty)*num(line.factor||1));return `<tr><td>${esc(dateText(sale.date))}</td><td>${esc(sale.receiptNo)}</td><td><b>${esc(line.name)}</b><div class="muted">${esc(line.code||'')}</div></td><td>${esc(p?.createdAt?dateOnly(p.createdAt):'—')}</td><td>${esc(formatQty(line.qty))} ${esc(line.unit||'')}</td><td>${money(revenue)}</td><td>${money(profit)}</td><td>${stockEvent?esc(dateText(sale.date)):'—'}</td></tr>`;}).join('')}</tbody></table></div>`:emptyState('No product sales yet','Completed sales will appear here, with item quantities and gross profit.');
}
async function renderAll() { await updateSelects(); await renderDashboard(); await renderProducts(); await renderSalePage(); await renderCustomers(); await renderHistory(); await renderReports(); }

async function openScanner(target) {
  scannerTarget=target;
  if(!('BarcodeDetector' in window)){showToast('Live camera scanning is not supported in this browser. Type or use a USB/Bluetooth barcode scanner in the barcode field.');return;}
  if(!navigator.mediaDevices?.getUserMedia){showToast('Camera access is unavailable. Enter the barcode manually.');return;}
  try {
    const supported=await window.BarcodeDetector.getSupportedFormats();
    const preferred=['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf','qr_code'];
    const formats=preferred.filter(f=>supported.includes(f));
    if(!formats.length){showToast('This browser cannot scan common retail barcodes. Enter the barcode manually.');return;}
    scannerDetector=new window.BarcodeDetector({formats});
    scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    $('scanner-video').srcObject=scannerStream;$('scanner-modal').classList.add('show');$('scanner-message').textContent='Point the camera at the barcode and hold it steady.';
    await $('scanner-video').play();
    const scanFrame=async()=>{
      if(!scannerStream||!scannerDetector)return;
      try{const hits=await scannerDetector.detect($('scanner-video'));if(hits&&hits.length&&hits[0].rawValue){const value=hits[0].rawValue;stopScanner();if(scannerTarget==='product'){$('p-code').value=value;showToast('Barcode filled into product form.');}else{$('sale-barcode').value=value;await addByBarcode(value);}return;}}catch(e){/* Wait for the next frame; camera frames can be temporarily unreadable. */}
      scannerFrame=requestAnimationFrame(scanFrame);
    };
    scannerFrame=requestAnimationFrame(scanFrame);
  } catch(err) { console.warn(err); stopScanner(); showToast('Could not open the camera. Check browser permission or enter the barcode manually.'); }
}
function imageColorSignature(source) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas'); canvas.width=12; canvas.height=12;
        const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(image,0,0,12,12);
        const pixels=ctx.getImageData(0,0,12,12).data, bins=new Array(12).fill(0);
        for(let i=0;i<pixels.length;i+=4){const r=pixels[i],g=pixels[i+1],b=pixels[i+2];const hue=Math.atan2(Math.sqrt(3)*(g-b),2*r-g-b);const bin=Math.floor((hue+Math.PI)/(2*Math.PI)*12)%12;bins[bin]++;}
        const total=bins.reduce((a,b)=>a+b,0)||1; resolve(bins.map(v=>v/total));
      } catch { resolve(null); }
    };
    image.onerror=()=>resolve(null); image.src=source;
  });
}
async function openPhotoToSell(file) {
  if(!file)return;
  if(file.size>8*1024*1024){showToast('That photo is too large. Choose a photo under 8 MB.');return;}
  let photo;
  try{photo=await fileToDataURL(file);}catch{showToast('Could not read that photo.');return;}
  $('sell-photo-preview').src=photo;
  const available=(await getAll('products')).filter(p=>num(p.stock)>0).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  if(!available.length){navigate('sale');showToast('There are no products in stock to sell.');return;}
  const signature=await imageColorSignature(photo);
  const photographed=available.filter(p=>p.photoData);
  let matches=available;
  let matchedPhotos=false;
  if(signature&&photographed.length){
    const ranked=await Promise.all(photographed.map(async p=>{
      const other=await imageColorSignature(p.photoData);
      const distance=other?Math.sqrt(signature.reduce((sum,v,i)=>sum+(v-other[i])**2,0)):Infinity;
      return {product:p,distance};
    }));
    const usable=ranked.filter(x=>Number.isFinite(x.distance)).sort((a,b)=>a.distance-b.distance);
    if(usable.length){matches=usable.slice(0,5).map(x=>x.product);matchedPhotos=true;}
  }
  $('photo-match-note').textContent=matchedPhotos?'Top visual matches from product photos in your stock. Confirm the correct item to add it to the sale.':'No product-photo match is available. Choose the matching item from your current stock.';
  $('photo-match-list').innerHTML=matches.map((p,i)=>`<button type="button" class="btn block" data-sell-product="${p.id}" style="justify-content:flex-start;margin-top:8px">${productPhoto(p,'42px')}<span style="text-align:left;white-space:normal;flex:1"><b>${esc(p.name)}</b><br><small>${esc(formatQty(p.stock))} ${esc(p.unit)} available · ${money(p.price)}</small></span>${matchedPhotos&&i===0?'<span class="pill good">Closest match</span>':''}</button>`).join('');
  $('photo-match-modal').classList.add('show');
}
async function addPhotoMatchedProduct(id) {
  const product=await getOne('products',id); if(!product||num(product.stock)<=0){showToast('That product is no longer in stock.');return;}
  navigate('sale');
  $('sale-product').value=String(product.id); await refreshSaleUnitOptions();
  await addCartProduct(product);
  $('photo-match-modal').classList.remove('show');
}
function stopScanner() {
  if(scannerFrame!==null)cancelAnimationFrame(scannerFrame);scannerFrame=null;
  if(scannerStream){scannerStream.getTracks().forEach(track=>track.stop());scannerStream=null;}
  if($('scanner-video'))$('scanner-video').srcObject=null;
  $('scanner-modal').classList.remove('show');scannerDetector=null;
}

// Bind primary navigation directly. This is intentionally separate from delegated action buttons.
document.querySelectorAll('.nav-btn[data-page]').forEach(button => {
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    navigate(button.dataset.page);
  });
});

// Main event wiring: delegation keeps dynamically generated rows and shortcut buttons interactive.
document.addEventListener('click', async event => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target) return;
  const nav=target.closest('[data-page]');if(nav){navigate(nav.dataset.page);return;}
  const go=target.closest('[data-go]');if(go){navigate(go.dataset.go);return;}
  const scan=target.closest('[data-scan]');if(scan){await openScanner(scan.dataset.scan);return;}
  const action=target.closest('[data-action]');if(action){const {action:kind,id}=action.dataset;
    if(kind==='capture-to-sell'){$('sell-photo-input').click();return;}
    if(kind==='edit-product')await editProduct(id);
    if(kind==='delete-product')await deleteProduct(id);
    if(kind==='remove-cart'){cart=cart.filter(l=>l.key!==id);renderCart();}
    if(kind==='edit-customer')await editCustomer(id);
    if(kind==='pay-customer'){$('payment-customer').value=String(id);$('payment-amount').focus();$('payment-form').scrollIntoView({behavior:'smooth',block:'center'});}
    if(kind==='customer-history'){await renderCustomerRecordHistory(Number(id));$('customer-record-history').scrollIntoView({behavior:'smooth',block:'center'});}
    if(kind==='print-sale'){const sale=await getOne('sales',id);await printReceipt(sale);} if(kind==='image-sale'){const sale=await getOne('sales',id);await exportSaleReceiptImage(sale);} if(kind==='share-sale'){const sale=await getOne('sales',id);await shareSaleReceiptImage(sale);}
  }
});
$('product-form').addEventListener('submit',saveProduct);
$('reset-product').addEventListener('click',resetProductForm);
$('cancel-product-edit').addEventListener('click',resetProductForm);
$('new-product-btn').addEventListener('click',()=>{resetProductForm();$('p-name').focus();});
$('product-search').addEventListener('input',()=>renderProducts());
$('stock-filter').addEventListener('change',()=>renderProducts());
$('store-name-form').addEventListener('submit',saveStoreName);
$('export-product-sales-image').addEventListener('click',exportProductSalesImage);
$('export-products-csv').addEventListener('click',async()=>exportProductsCSV(await getAll('products')));
$('sale-product').addEventListener('change',refreshSaleUnitOptions);
$('sale-unit').addEventListener('change',setSalePriceFromUnit);
$('add-cart-item').addEventListener('click',async()=>{const p=await getOne('products',$('sale-product').value);if(!p)return showToast('Add a product first.');await addCartProduct(p);});
$('sale-barcode').addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();await addByBarcode(e.currentTarget.value);}});
$('sale-barcode').addEventListener('change',async e=>{if(e.currentTarget.value.trim()) await addByBarcode(e.currentTarget.value);});
$('clear-cart').addEventListener('click',()=>{cart=[];renderCart();});
$('cart-lines').addEventListener('change',event=>{const qtyKey=event.target.dataset.cartQty;const priceKey=event.target.dataset.cartPrice;if(!qtyKey&&!priceKey)return;const line=cart.find(l=>l.key===(qtyKey||priceKey));if(!line)return;if(qtyKey){const value=num(event.target.value);if(!(value>0)){event.target.value=line.qty;return showToast('Quantity must be greater than zero.');}line.qty=value;}if(priceKey){const value=num(event.target.value);if(value<0){event.target.value=line.unitPrice;return showToast('Price cannot be negative.');}line.unitPrice=cents(value);}renderCart();});
$('sale-type').addEventListener('change',()=>{const total=cartTotal();$('sale-paid').value=$('sale-type').value==='cash'?total:'0';updateCheckoutNotice();});
$('sale-customer').addEventListener('change',updateCheckoutNotice);$('sale-paid').addEventListener('input',updateCheckoutNotice);
$('sale-add-customer').addEventListener('click',()=>{$('quick-customer-modal').classList.add('show');$('quick-customer-name').focus();});
$('close-quick-customer').addEventListener('click',()=> $('quick-customer-modal').classList.remove('show'));
$('quick-customer-modal').addEventListener('click',e=>{if(e.target===$('quick-customer-modal'))$('quick-customer-modal').classList.remove('show');});
$('quick-customer-form').addEventListener('submit',addQuickCustomer);
$('checkout-form').addEventListener('submit',completeSale);
$('customer-form').addEventListener('submit',saveCustomer);$('reset-customer').addEventListener('click',resetCustomerForm);
$('payment-form').addEventListener('submit',recordPayment);$('customer-search').addEventListener('input',renderCustomers);
$('history-search').addEventListener('input',renderHistory);$('history-type').addEventListener('change',renderHistory);
$('export-sales-csv').addEventListener('click',async()=>exportSalesCSV(filteredHistorySales(await getAll('sales'))));
$('export-sales-image').addEventListener('click',exportSalesHistoryImage);
$('export-report-csv').addEventListener('click',exportSalesSummaryExcel);
$('backup-json').addEventListener('click',exportBackup);
$('delete-app-data').addEventListener('click',deleteAllAppData);
$('backup-products').addEventListener('click',async()=>exportProductsCSV(await getAll('products')));
$('backup-sales').addEventListener('click',async()=>exportSalesCSV(await getAll('sales')));
$('restore-file').addEventListener('change',async e=>{await restoreBackup(e.currentTarget.files?.[0]);e.currentTarget.value='';});
$('capture-product-photo').addEventListener('click',()=> $('p-photo').click());$('p-photo').addEventListener('change',async e=>{const file=e.currentTarget.files?.[0];if(!file)return;if(file.size>6*1024*1024){e.currentTarget.value='';showToast('Photo is larger than 6 MB.');return;}try{$('photo-preview-img').src=await fileToDataURL(file);$('photo-preview').classList.remove('hidden');}catch{showToast('Could not preview this photo.');}});
$('close-scanner').addEventListener('click',stopScanner);$('stop-scanner').addEventListener('click',stopScanner);$('scanner-modal').addEventListener('click',e=>{if(e.target===$('scanner-modal'))stopScanner();});
$('sell-photo-input').addEventListener('change',async e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';await openPhotoToSell(file);});
$('close-photo-match').addEventListener('click',()=> $('photo-match-modal').classList.remove('show'));
$('photo-match-modal').addEventListener('click',e=>{if(e.target===$('photo-match-modal'))$('photo-match-modal').classList.remove('show');});
$('photo-match-list').addEventListener('click',async e=>{const button=e.target.closest('[data-sell-product]');if(button)await addPhotoMatchedProduct(button.dataset.sellProduct);});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){stopScanner();$('photo-match-modal').classList.remove('show');}});

(async function boot(){
  try {
    if(!('indexedDB' in window))throw new Error('This browser does not support IndexedDB. Please use a recent version of Chrome, Edge, Firefox or Safari.');
    applyStoreName();
    populateStaticSelects();
    db=await openDatabase();
    if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(err=>console.warn('Service worker could not be installed:',err));
    }
    await renderAll();
  } catch(err) {
    console.error(err);
    document.querySelector('main').innerHTML=`<div class="panel"><h2>StoreLedger could not start</h2><p>${esc(err.message)}</p><p>Open the app from localhost or HTTPS, not directly as a file, and use a modern browser.</p></div>`;
  }
})();

