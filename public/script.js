const APIURL = '/api/orders';
const ADDPRODUCTURL = '/api/addproduct';

const CLOUDNAME = 'dh4c49ca4'; 
const UPLOADPRESET = 'Thrills'; 

let allOrders = [];
let allChats = [];
let botStatuses = {};
let currentFilter = 'New';
let activeChatPhone = null;
let chatFilter = 'all';

function checkPassword() {
    const pass = document.getElementById('adminPassword').value;
    if (pass === 'admin123') {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        fetchOrders();
        fetchChats();
        setInterval(fetchOrders, 10000); 
        setInterval(fetchChats, 5000); 
    } else { alert('Wrong Password!'); }
}

function logout() {
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('adminPassword').value = '';
}

function switchTab(tabId, element) {
    document.querySelectorAll('.tabContent').forEach(tab => tab.classList.remove('activeContent'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(tabId).classList.add('activeContent');
    element.classList.add('active');
}

async function fetchOrders() {
    try {
        const response = await fetch(APIURL);
        allOrders = await response.json();
        renderOrders();
    } catch (error) { console.error(error); }
}

function filterOrders(status) {
    currentFilter = status;
    document.querySelectorAll('.filterBtn').forEach(btn => {
        btn.classList.remove('activeFilter');
        if(btn.innerText.includes(status)) btn.classList.add('activeFilter');
    });
    renderOrders();
}

function renderOrders() {
    const container = document.getElementById('ordersContainer');
    container.innerHTML = '';
    const filtered = allOrders.filter(o => o.status === currentFilter);
    if(filtered.length === 0) {
        container.innerHTML = '<p>No orders found.</p>';
        return;
    }
    filtered.forEach(order => {
        const card = document.createElement('div');
        card.className = 'orderCard';
        card.innerHTML = `
            <div class="orderDetails">
                <h4>Order ID: #${order.id}</h4>
                <p><strong>Phone:</strong> ${order.phone}</p>
                <p><strong>Name:</strong> ${order.name}</p>
                <p><strong>Address:</strong> ${order.address}</p>
                <p><strong>Items:</strong> ${order.items}</p>
                <p><strong>Total Bill:</strong> Rs ${order.total}</p>
                <p><strong>Time:</strong> ${order.time}</p>
            </div>
            <div class="orderActions">
                <select id="status${order.id}">
                    <option value="New" ${order.status === 'New' ? 'selected' : ''}>New</option>
                    <option value="Confirmed" ${order.status === 'Confirmed' ? 'selected' : ''}>Confirmed</option>
                    <option value="Dispatched" ${order.status === 'Dispatched' ? 'selected' : ''}>Dispatched</option>
                    <option value="Completed" ${order.status === 'Completed' ? 'selected' : ''}>Completed</option>
                </select>
                <button onclick="updateStatus(${order.id})">Update Status</button>
            </div>
        `;
        container.appendChild(card);
    });
}

async function updateStatus(id) {
    const newStatus = document.getElementById('status' + id).value;
    try {
        const res = await fetch(APIURL + '/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, status: newStatus })
        });
        const data = await res.json();
        if(data.success) { alert("Status successfully updated!"); fetchOrders(); }
    } catch (e) { alert("Error updating status"); }
}

async function fetchChats() {
    try {
        const response = await fetch('/api/chats');
        const data = await response.json();
        allChats = data.messages;
        botStatuses = {};
        data.statuses.forEach(s => { botStatuses[s[0]] = s[1]; });
        renderChatList();
        if (activeChatPhone) renderChatWindow(activeChatPhone);
    } catch (e) {}
}

function setChatFilter(val) {
    chatFilter = val;
    renderChatList();
}

function renderChatList() {
    const listContainer = document.getElementById('chatListContainer');
    const searchVal = document.getElementById('chatSearch').value.toLowerCase();
    listContainer.innerHTML = '';

    const uniquePhones = [...new Set(allChats.map(m => m[0]))];

    uniquePhones.forEach(phone => {
        const hasOrder = allOrders.some(o => o.phone === phone);
        if (chatFilter === 'confirmed' && !hasOrder) return;
        if (chatFilter === 'notconfirmed' && hasOrder) return;
        if (searchVal && !phone.toLowerCase().includes(searchVal)) return;

        const div = document.createElement('div');
        div.className = `chatUserItem ${activeChatPhone === phone ? 'activeChat' : ''}`;
        div.innerHTML = `<strong>${phone}</strong> <br><small>${hasOrder ? 'Order Holder' : 'Visitor'}</small>`;
        div.onclick = () => { activeChatPhone = phone; renderChatWindow(phone); };
        listContainer.appendChild(div);
    });
}

function renderChatWindow(phone) {
    const windowContainer = document.getElementById('chatWindowMessages');
    windowContainer.innerHTML = '';
    
    const userMsgs = allChats.filter(m => m[0] === phone);
    userMsgs.forEach(m => {
        const div = document.createElement('div');
        div.className = `messageBubble ${m[1].toLowerCase() === 'customer' ? 'msgCustomer' : 'msgBot'}`;
        
        let contentHtml = `<p>${m[3]}</p>`;
        if (m[2] === 'image' && m[3].startsWith('http')) {
            contentHtml = `<a href="${m[3]}" target="_blank"><img src="${m[3]}" class="chatImage" alt="Customer Image" /></a>`;
        }

        div.innerHTML = `<strong>${m[1]}:</strong> ${contentHtml} <span class="timeStamp">${m[4]}</span>`;
        windowContainer.appendChild(div);
    });

    const isPaused = botStatuses[phone] === 'Paused';
    document.getElementById('botToggleBtn').innerText = isPaused ? "Resume Bot Auto-Reply" : "Pause Bot (Take Over Chat)";
    document.getElementById('botToggleBtn').className = isPaused ? "btnResume" : "btnPause";
    
    const linkedOrder = allOrders.find(o => o.phone === phone);
    const detailsContainer = document.getElementById('chatOrderSidebar');
    if (linkedOrder) {
        detailsContainer.innerHTML = `<h4>Order Info</h4><p>ID: #${linkedOrder.id}</p><p>Name: ${linkedOrder.name}</p><p>Total: Rs ${linkedOrder.total}</p><p>Status: ${linkedOrder.status}</p>`;
    } else { detailsContainer.innerHTML = `<h4>No Active Order</h4>`; }
}

async function toggleBot() {
    if (!activeChatPhone) return;
    const current = botStatuses[activeChatPhone] === 'Paused' ? 'Active' : 'Paused';
    await fetch('/api/chats/togglebot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: activeChatPhone, status: current })
    });
    fetchChats();
}

async function sendManualReply() {
    const text = document.getElementById('manualReplyInput').value;
    if (!text || !activeChatPhone) return;
    await fetch('/api/chats/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: activeChatPhone, text: text })
    });
    document.getElementById('manualReplyInput').value = '';
    fetchChats();
}

async function uploadAndSaveProduct() {
    const name = document.getElementById('itemName').value;
    const size = document.getElementById('itemSize').value;
    const price = document.getElementById('itemPrice').value;
    const fileInput = document.getElementById('videoFile');
    const statusText = document.getElementById('uploadStatus');

    if (!name || !size || !price || fileInput.files.length === 0) {
        alert("Please fill all fields.");
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('upload_preset', UPLOADPRESET);

    statusText.innerText = "Uploading to Cloudinary...";
    document.getElementById('uploadBtn').disabled = true;

    try {
        const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDNAME}/video/upload`, { method: 'POST', body: formData });
        const uploadData = await uploadRes.json();
        if (!uploadData.secure_url) throw new Error("Upload Failed");

        statusText.innerText = "Saving to Google Sheets...";
        const saveRes = await fetch(ADDPRODUCTURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, size, price, videoUrl: uploadData.secure_url })
        });
        const saveData = await saveRes.json();
        if (saveData.success) {
            statusText.innerText = "Product successfully live!";
            statusText.style.color = "green";
        }
    } catch (e) { statusText.innerText = "Error: " + e.message; statusText.style.color = "red"; }
    finally { document.getElementById('uploadBtn').disabled = false; }
}