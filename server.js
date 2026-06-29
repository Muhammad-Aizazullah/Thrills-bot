const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const WHATSAPPTOKEN = process.env.WHATSAPP_TOKEN;
const PHONENUMBERID = process.env.PHONE_NUMBER_ID;
const SPREADSHEETID = process.env.SPREADSHEET_ID;

const sessions = {}; 
let orderIdCounter = 1001;

function getSession(phone) {
    if (!sessions[phone]) {
        sessions[phone] = { cart: [], tempSelection: null, step: 'start', customerDetails: '', customerName: '', customerAddress: '' };
    }
    return sessions[phone];
}

const auth = new google.auth.GoogleAuth({
    credentials: process.env.GOOGLE_CREDENTIALS ? JSON.parse(process.env.GOOGLE_CREDENTIALS) : {},
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], 
});

// Naya Function: WhatsApp say image lay kar Cloudinary par upload karnay k liyay
async function processWhatsAppMedia(mediaId) {
    try {
        const res = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` }
        });
        
        const mediaUrl = res.data.url;
        const mimeType = res.data.mime_type || 'image/jpeg';
        
        const mediaRes = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` },
            responseType: 'arraybuffer'
        });
        
        const base64Str = Buffer.from(mediaRes.data, 'binary').toString('base64');
        const dataUri = `data:${mimeType};base64,${base64Str}`;
        
        const cloudRes = await axios.post(`https://api.cloudinary.com/v1_1/dh4c49ca4/image/upload`, {
            file: dataUri,
            upload_preset: 'Thrills'
        });
        
        return cloudRes.data.secure_url;
    } catch (e) {
        console.error("Media Upload Error:", e.message);
        return null;
    }
}

async function getSheetData() {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEETID,
            range: 'Sheet1!A2:D100', 
        });
        return response.data.values || [];
    } catch (error) {
        throw new Error("Sheet1 read error: " + error.message);
    }
}

async function saveMessageToSheet(phone, sender, type, body) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEETID,
            range: 'Messages!A:E',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[phone, sender, type, body, new Date().toLocaleString()]] }
        });
    } catch (e) { console.error("Messages Tab Save Error:", e.message); }
}

async function getBotStatus(phone) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEETID, range: 'BotStatus!A2:B100' });
        const rows = response.data.values || [];
        const row = rows.find(r => r[0] === phone);
        return row ? row[1] : 'Active';
    } catch (e) { return 'Active'; }
}

async function setBotStatus(phone, status) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEETID, range: 'BotStatus!A2:A100' });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => r[0] === phone) + 2;
        if (rowIndex > 1) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEETID,
                range: `BotStatus!B${rowIndex}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[status]] }
            });
        } else {
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEETID,
                range: 'BotStatus!A:B',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[phone, status]] }
            });
        }
    } catch (e) { console.error(e); }
}

async function saveOrderToSheet(order) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const itemsString = order.items.map(i => `${i.item}(${i.size})`).join(', ');
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEETID,
            range: 'Orders!A:H',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[order.id, order.phone, itemsString, order.total, order.name, order.address, order.time, 'New']] }
        });
    } catch (error) { console.error(error); }
}

app.get('/api/orders', async (req, res) => {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEETID, range: 'Orders!A2:H100' });
        const rows = response.data.values || [];
        res.json(rows.map(row => ({
            id: row[0], phone: row[1], items: row[2], total: row[3], name: row[4], address: row[5], time: row[6], status: row[7] || 'New'
        })));
    } catch (error) { res.json([]); }
});

app.post('/api/orders/update', async (req, res) => {
    try {
        const { id, status } = req.body;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEETID, range: 'Orders!A2:A100' });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => r[0] === id.toString()) + 2;
        if (rowIndex > 1) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEETID, range: `Orders!H${rowIndex}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[status]] }
            });
            res.json({ success: true });
        } else { res.status(404).json({ success: false }); }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/chats', async (req, res) => {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const msgRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEETID, range: 'Messages!A2:E1000' });
        const statusRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEETID, range: 'BotStatus!A2:B100' });
        res.json({ messages: msgRes.data.values || [], statuses: statusRes.data.values || [] });
    } catch (e) { res.json({ messages: [], statuses: [] }); }
});

app.post('/api/chats/reply', async (req, res) => {
    const { phone, text } = req.body;
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: phone, text: { body: text }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
        await saveMessageToSheet(phone, 'Admin', 'text', text);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/chats/togglebot', async (req, res) => {
    const { phone, status } = req.body;
    await setBotStatus(phone, status);
    res.json({ success: true });
});

app.post('/api/addproduct', async (req, res) => {
    try {
        const { name, size, price, videoUrl } = req.body;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEETID, range: 'Sheet1!A:D', valueInputOption: 'USER_ENTERED', requestBody: { values: [[name, size, price, videoUrl]] }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

app.post('/webhook', async (req, res) => {
    const senderPhone = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
    
    try {
        if (!req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return res.sendStatus(200);
        const message = req.body.entry[0].changes[0].value.messages[0];
        const session = getSession(senderPhone);

        let bodyText = "";
        if (message.type === 'text') {
            bodyText = message.text.body;
        } 
        else if (message.type === 'image') {
            // Media Process ho kar Cloudinary par upload hoga
            const mediaId = message.image.id;
            const uploadedUrl = await processWhatsAppMedia(mediaId);
            bodyText = uploadedUrl ? uploadedUrl : "[Screenshot Error]";
        } 
        else if (message.type === 'interactive') {
            bodyText = `[Selected: ${message.interactive.list_reply?.title || message.interactive.button_reply?.title}]`;
        }

        await saveMessageToSheet(senderPhone, 'Customer', message.type, bodyText);

        const currentBotStatus = await getBotStatus(senderPhone);
        if (currentBotStatus === 'Paused') return res.sendStatus(200);

        if (message.type === 'image') {
            if (session.step === 'awaitingSS') {
                session.step = 'awaitingName';
                await sendText(senderPhone, "SS mil gaya! Ab kindly apna Full Name bhej dein:");
            } else if (session.tempSelection) {
                session.cart.push(session.tempSelection);
                session.tempSelection = null;
                await sendCheckoutMenu(senderPhone);
            } else {
                // FALLBACK: Agar bot stuck ho raha tha
                await sendText(senderPhone, "Mujhe aap ki tasveer mil gai ha, lekin pehlay menu say koi item select karein ta k main usay cart mein daal sakoon.");
                await sendDynamicMainMenu(senderPhone);
            }
            return res.sendStatus(200);
        }

        if (message.type === 'text') {
            if (session.step === 'awaitingName') {
                session.customerName = message.text.body;
                session.step = 'awaitingAddress';
                await sendText(senderPhone, "Name save ho gaya! Ab apna mukammal Address bhej dein:");
            } else if (session.step === 'awaitingAddress') {
                session.customerAddress = message.text.body;
                let totalBill = session.cart.reduce((sum, item) => sum + parseInt(item.price), 0);
                
                const newOrder = {
                    id: orderIdCounter++, phone: senderPhone, items: [...session.cart], total: totalBill, name: session.customerName, address: session.customerAddress, time: new Date().toLocaleString()
                };
                await saveOrderToSheet(newOrder);
                await sendText(senderPhone, "Aap ka order confirm ho gaya ha! Thrills Store say shopping karne ka shukriya.");
                sessions[senderPhone] = { cart: [], tempSelection: null, step: 'start', customerDetails: '', customerName: '', customerAddress: '' };
            } else {
                await sendDynamicMainMenu(senderPhone);
            }
            return res.sendStatus(200);
        }

        if (message.type === 'interactive') {
            const replyId = (message.interactive.list_reply || message.interactive.button_reply).id;
            if (replyId.startsWith('cat')) await sendDynamicSizes(senderPhone, replyId.split('cat')[1]);
            else if (replyId.startsWith('size')) {
                const parts = replyId.split('size')[1].split('xx');
                await sendDynamicPrices(senderPhone, parts[0], parts[1]);
            }
            else if (replyId.startsWith('price')) {
                const parts = replyId.split('price')[1].split('xx');
                const rows = await getSheetData();
                const matchedRow = rows.find(r => r[0] && r[0].toLowerCase().trim() === parts[0].toLowerCase().trim() && r[1] && r[1].toLowerCase().trim() === parts[1].toLowerCase().trim() && r[2] && r[2].toLowerCase().trim() === parts[2].toLowerCase().trim());
                if (matchedRow) {
                    session.tempSelection = { item: matchedRow[0], size: matchedRow[1], price: matchedRow[2] };
                    await sendVideo(senderPhone, matchedRow[3]);
                } else {
                    await sendText(senderPhone, "Is waqt ye item load nahi ho rahi, admin ko message bhej dia gaya ha.");
                }
            }
            else if (replyId === 'checkout') {
                let billText = "🛍️ *Aap Ka Total Bill* 🛍️\n\n";
                let total = 0;
                session.cart.forEach((c, index) => {
                    billText += `Item${index + 1} name: ${c.item}\nItem${index + 1} Price: ${c.price}\n\n`;
                    total += parseInt(c.price);
                });
                billText += `*Total Bill:* ${total}\n\n💳 *Payment Details:*\nEasypaisa Account: 03123123123\n\nKindly is number par payment kar k **Screenshot** isi chat mein bhejein.`;
                session.step = 'awaitingSS';
                await sendText(senderPhone, billText);
            }
            else if (replyId === 'addmore') await sendDynamicMainMenu(senderPhone);
        }
    } catch (err) { 
        console.error(err); 
        if(senderPhone) await sendText(senderPhone, "Bot Error Aagaya Ha: " + err.message);
    }
    res.sendStatus(200);
});

async function sendDynamicMainMenu(to) {
    try {
        const rows = await getSheetData();
        const categories = [...new Set(rows.map(r => r[0] ? r[0].trim() : ''))].filter(Boolean);
        
        if (categories.length === 0) {
            await sendText(to, "Thrills Bot Active Ha, lekin Google Sheet say items nahi mil rahi. Tabs check karein.");
            return;
        }
        
        const listRows = categories.map(cat => ({ id: `cat${cat}`, title: cat }));
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Thrills Store" }, body: { text: "Kia dekhna pasand karein gay?" }, footer: { text: "Menu" }, action: { button: "Categories", sections: [{ title: "Items", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) {
        await sendText(to, "Main Menu Error: " + e.message);
    }
}

async function sendDynamicSizes(to, category) {
    const rows = await getSheetData();
    const sizes = [...new Set(rows.filter(r => r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim()).map(r => r[1] ? r[1].trim() : ''))].filter(Boolean);
    const listRows = sizes.map(size => ({ id: `size${category}xx${size}`, title: size }));
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Sizes" }, body: { text: `Aap nay ${category} select kia ha. Size select karein:` }, footer: { text: "Thrills" }, action: { button: "Sizes", sections: [{ title: "Sizes", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) {}
}

async function sendDynamicPrices(to, category, size) {
    const rows = await getSheetData();
    const prices = [...new Set(rows.filter(r => r[0] && r[0].toLowerCase().trim() === category.toLowerCase().trim() && r[1] && r[1].toLowerCase().trim() === size.toLowerCase().trim()).map(r => r[2] ? r[2].trim() : ''))].filter(Boolean);
    const listRows = prices.map(price => ({ id: `price${category}xx${size}xx${price}`, title: `Rs ${price}` }));
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "list", header: { type: "text", text: "Prices" }, body: { text: `Price select karein:` }, footer: { text: "Thrills" }, action: { button: "Prices", sections: [{ title: "Prices", rows: listRows }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) {}
}

async function sendCheckoutMenu(to) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, {
            messaging_product: "whatsapp", to: to, type: "interactive",
            interactive: {
                type: "button", body: { text: "Kia aap mazeed items add karna chahtay hain ya checkout?" }, action: { buttons: [{ type: "reply", reply: { id: "addmore", title: "Add More" } }, { type: "reply", reply: { id: "checkout", title: "Checkout" } }] }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
    } catch (e) {}
}

async function sendVideo(to, url) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, { messaging_product: "whatsapp", to: to, type: "video", video: { link: url } }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
        await saveMessageToSheet(to, 'Bot', 'video', `Sent Video Link: ${url}`);
    } catch (e) { await sendText(to, `Video Link: ${url}`); }
}

async function sendText(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONENUMBERID}/messages`, { messaging_product: "whatsapp", to: to, text: { body: text } }, { headers: { Authorization: `Bearer ${WHATSAPPTOKEN}` } });
        await saveMessageToSheet(to, 'Bot', 'text', text);
    } catch (e) {}
}

app.listen(PORT, () => console.log(`Live`));