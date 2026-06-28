const APIURL = '/api/orders';
const ADD_PRODUCT_URL = '/api/add-product';

const CLOUD_NAME = 'dh4c49ca4'; 
const UPLOAD_PRESET = 'Thrills'; 

let allOrders = [];
let currentFilter = 'New';

function checkPassword() {
    const pass = document.getElementById('adminPassword').value;
    if (pass === 'admin123') {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        fetchOrders();
        setInterval(fetchOrders, 10000); 
    } else {
        alert('Wrong Password!');
    }
}

function logout() {
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('adminPassword').value = '';
}

function switchTab(tabId, element) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active-content'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active-content');
    element.classList.add('active');
}

async function fetchOrders() {
    try {
        const response = await fetch(APIURL);
        allOrders = await response.json();
        renderOrders();
    } catch (error) { console.error('Error fetching orders:', error); }
}

function filterOrders(status) {
    currentFilter = status;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active-filter');
        if(btn.innerText.includes(status)) btn.classList.add('active-filter');
    });
    renderOrders();
}

function renderOrders() {
    const container = document.getElementById('ordersContainer');
    container.innerHTML = '';
    
    const filtered = allOrders.filter(o => o.status === currentFilter);
    
    if(filtered.length === 0) {
        container.innerHTML = '<p>No orders found in this category.</p>';
        return;
    }

    filtered.forEach(order => {
        let itemsHtml = order.items.map(i => `${i.item} (Size: ${i.size}) - Rs ${i.price}`).join('<br>');
        
        const card = document.createElement('div');
        card.className = 'orderCard';
        card.innerHTML = `
            <div class="orderDetails">
                <h4>Order ID: #${order.id}</h4>
                <p><strong>Phone:</strong> ${order.phone}</p>
                <p><strong>Date:</strong> ${order.time}</p>
                <div class="orderItems">${itemsHtml}</div>
                <p><strong>Total Bill:</strong> Rs ${order.total}</p>
            </div>
            <div class="orderActions">
                <select id="status_${order.id}">
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
    const newStatus = document.getElementById('status_' + id).value;
    await fetch(APIURL + '/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, status: newStatus })
    });
    fetchOrders();
}

async function uploadAndSaveProduct() {
    const name = document.getElementById('itemName').value;
    const size = document.getElementById('itemSize').value;
    const price = document.getElementById('itemPrice').value;
    const fileInput = document.getElementById('videoFile');
    const statusText = document.getElementById('uploadStatus');

    if (!name || !size || !price || fileInput.files.length === 0) {
        alert("Please fill all fields and select a video.");
        return;
    }

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', UPLOAD_PRESET); 

    statusText.innerText = "Uploading video... Please wait.";
    document.getElementById('uploadBtn').disabled = true;

    try {
        const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`, {
            method: 'POST',
            body: formData
        });
        
        const uploadData = await uploadRes.json();
        
        if (!uploadData.secure_url) {
            throw new Error("Video upload failed. Check Cloudinary settings.");
        }

        const videoUrl = uploadData.secure_url;
        statusText.innerText = "Video uploaded! Saving to database...";

        const saveRes = await fetch(ADD_PRODUCT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, size, price, videoUrl })
        });

        const saveData = await saveRes.json();
        
        if (saveData.success) {
            statusText.innerText = "Product added successfully!";
            statusText.style.color = "green";
            
            document.getElementById('itemName').value = '';
            document.getElementById('itemSize').value = '';
            document.getElementById('itemPrice').value = '';
            fileInput.value = '';
        } else {
            throw new Error("Failed to save to Google Sheet.");
        }

    } catch (error) {
        console.error(error);
        statusText.innerText = "Error: " + error.message;
        statusText.style.color = "red";
    } finally {
        document.getElementById('uploadBtn').disabled = false;
    }
}