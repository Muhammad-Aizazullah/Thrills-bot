const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; 
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// Drive link ko direct media link mein convert karnay ka function
function makeDirectDriveLink(url) {
    const match = url.match(/\/d\/(.+?)\//);
    if (match && match[1]) {
        return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    }
    return url;
}

// Google Sheet se videos nikalne ka function
async function getVideosFromSheet(category, size, priceRange) {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A2:E100', // Columns: Category, Size, PriceRange, VideoUrl, Price
        });
        
        const rows = response.data.values;
        if (!rows || rows.length === 0) return [];
        
        let matchedVideos = [];
        for (let row of rows) {
            const rowCat = row[0] ? row[0].toLowerCase() : '';
            const rowSize = row[1] ? row[1].toLowerCase() : '';
            const rowPriceRange = row[2] ? row[2].toLowerCase() : '';
            const rowVideoUrl = row[3] ? row[3] : '';
            const rowPrice = row[4] ? row[4] : '';

            if (rowCat === category && rowSize === size && (priceRange === 'all' || rowPriceRange === priceRange)) {
                matchedVideos.push({
                    url: makeDirectDriveLink(rowVideoUrl),
                    price: rowPrice
                });
            }
        }
        return matchedVideos;
    } catch (error) {
        console.error("Sheet Error:", error);
        return [];
    }
}

app.get('/webhook', (req, res) => {
    const verifyToken = process.env.VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === verifyToken) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post('/webhook', async (req, res) => {
    if (req.body.object) {
        if (req.body.entry && req.body.entry[0].changes && req.body.entry[0].changes[0].value.messages && req.body.entry[0].changes[0].value.messages[0]) {
            
            const message = req.body.entry[0].changes[0].value.messages[0];
            const senderPhone = message.from;

            if (message.type === 'image') {
                await sendText(senderPhone, "Bohat khoob! Aap ki pasandida item select ho gai ha. Kuch he dair mein aap ko final bill aur account details mil jayen gi. Payment 100% advance ha. Shukriya!");
                await sendText(ADMIN_NUMBER, `New Order Alert! Is number say screenshot aya ha: ${senderPhone}. Fauran check krien.`);
                return res.sendStatus(200);
            }

            if (message.type === 'text') {
                const textBody = message.text.body.toLowerCase();

                if (textBody.includes('shirt')) {
                    await sendSizeMenu(senderPhone, 'shirt');
                } else if (textBody.includes('trouser')) {
                    await sendSizeMenu(senderPhone, 'trouser');
                } else if (textBody.includes('pant')) {
                    await sendSizeMenu(senderPhone, 'pant');
                } else if (textBody.includes('discount') || textBody.includes('kam')) {
                    await sendText(senderPhone, "Maazrat, humari prices bilkul fixed hein aur hum koi discount offer nahi kartay. Humari policy sirf Advance Payment ki ha.");
                } else {
                    await sendMainMenu(senderPhone);
                }
                return res.sendStatus(200);
            }

            if (message.type === 'interactive') {
                const interactiveObj = message.interactive.button_reply || message.interactive.list_reply;
                const replyId = interactiveObj.id;

                if (replyId.startsWith('cat_')) {
                    const category = replyId.split('_')[1]; 
                    await sendSizeMenu(senderPhone, category);
                }
                else if (replyId.startsWith('size_')) {
                    const parts = replyId.split('_');
                    const category = parts[1];
                    const size = parts[2];
                    await sendPriceRangeMenu(senderPhone, category, size);
                }
                else if (replyId.startsWith('price_')) {
                    const parts = replyId.split('_');
                    const category = parts[1];
                    const size = parts[2];
                    const range = parts[3];

                    await sendText(senderPhone, "Great! Mein Thrills k database say aap ki pasandida items nikal raha hon. Thora intezar krien...");
                    
                    const videos = await getVideosFromSheet(category, size, range);

                    if (videos.length > 0) {
                        for (let vid of videos) {
                            await sendMediaVideo(senderPhone, vid.url, `Price Rs ${vid.price}\nJo pasand aaye uska Screenshot (SS) lay kar bhejein.`);
                        }
                    } else {
                        await sendText(senderPhone, "Maazrat, is waqt is selection mein koi video mojoud nahi ha. Baraye meharbani koi aur option try krien.");
                    }
                }
                return res.sendStatus(200);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

async function sendText(to, textContent) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            text: { body: textContent }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Text Error:", error.message); }
}

async function sendMediaVideo(to, videoUrl, captionText) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            type: "video",
            video: { link: videoUrl, caption: captionText }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { 
        console.error("Video Bhejnay Mein Masla:", error.response ? error.response.data : error.message);
        await sendText(to, `Video Link: ${videoUrl}\n\n${captionText}`);
    }
}

async function sendMainMenu(to) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "Thrills mein Khush Aamdeed! Kia dekhna pasand karein gay?" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "cat_shirt", title: "Shirts" } },
                        { type: "reply", reply: { id: "cat_trouser", title: "Trousers" } },
                        { type: "reply", reply: { id: "cat_pant", title: "Pants" } }
                    ]
                }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Main Menu error:", error.message); }
}

async function sendSizeMenu(to, category) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "list",
                header: { type: "text", text: "Size Select Karein" },
                body: { text: "Apna size muntakhib karein:" },
                footer: { text: "Thrills Store" },
                action: {
                    button: "Sizes Dekhein",
                    sections: [{
                        title: "Available Sizes",
                        rows: [
                            { id: `size_${category}_small`, title: "Small (S)" },
                            { id: `size_${category}_medium`, title: "Medium (M)" },
                            { id: `size_${category}_large`, title: "Large (L)" },
                            { id: `size_${category}_xl`, title: "Extra Large (XL)" }
                        ]
                    }]
                }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Size Menu error:", error.message); }
}

async function sendPriceRangeMenu(to, category, size) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: to,
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "Thrills ki apni pasandida price range select krien:" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: `price_${category}_${size}_under2000`, title: "Under 2000" } },
                        { type: "reply", reply: { id: `price_${category}_${size}_2to5k`, title: "2000 to 5000" } },
                        { type: "reply", reply: { id: `price_${category}_${size}_all`, title: "All Items" } }
                    ]
                }
            }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (error) { console.error("Price Menu error:", error.message); }
}

app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal rha ha. Local test k liyay tayar ha.`);
});