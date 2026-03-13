"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHistoryMsg = exports.downloadAndProcessHistorySyncNotification = exports.processHistoryMessage = exports.downloadHistory = void 0;
const util_1 = require("util");
const zlib_1 = require("zlib");
const WAProto_1 = require("../../WAProto");
const Types_1 = require("../Types");
const WABinary_1 = require("../WABinary");
const generics_1 = require("./generics");
const messages_1 = require("./messages");
const messages_media_1 = require("./messages-media");
const inflatePromise = (0, util_1.promisify)(zlib_1.inflate);
const downloadHistory = async (msg, options) => {
    const stream = await (0, messages_media_1.downloadContentFromMessage)(msg, 'md-msg-hist', { options });
    const bufferArray = [];
    for await (const chunk of stream) {
        bufferArray.push(chunk);
    }
    let buffer = Buffer.concat(bufferArray);
    // decompress buffer
    buffer = await inflatePromise(buffer);
    const syncData = WAProto_1.proto.HistorySync.decode(buffer);
    return syncData;
};
exports.downloadHistory = downloadHistory;
const processHistoryMessage = (item) => {
    var _a, _b, _c;
    const messages = [];
    const contacts = [];
    const chats = [];
    switch (item.syncType) {
        case WAProto_1.proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
        case WAProto_1.proto.HistorySync.HistorySyncType.RECENT:
        case WAProto_1.proto.HistorySync.HistorySyncType.FULL:
        case WAProto_1.proto.HistorySync.HistorySyncType.ON_DEMAND:
            // ── STEP 1: Build lid→phone map from chat objects BEFORE processing ──
            // Each chat carries pnJid (phone) when chat.id is @lid, or lidJid when
            // chat.id is a phone JID. Extract both so lidToJid() can resolve correctly.
            const lidEntries = [];
            for (const chat of item.conversations) {
                if (!chat.id) continue;
                if ((0, WABinary_1.isLidUser)(chat.id) && chat.pnJid) {
                    // chat.id = @lid, pnJid = real phone JID
                    lidEntries.push({ lid: chat.id, jid: chat.pnJid });
                } else if ((0, WABinary_1.isJidUser)(chat.id) && chat.lidJid) {
                    // chat.id = phone JID, lidJid = @lid counterpart
                    lidEntries.push({ lid: chat.lidJid, jid: chat.id });
                }
            }
            if (lidEntries.length > 0) {
                (0, WABinary_1.initLidPhoneMap)(lidEntries);
            }

            // ── STEP 2: Build lid→phone from contacts (has .lid field) ──
            // contacts array from item.contacts (if any, varies by sync type)
            if (Array.isArray(item.contacts)) {
                const contactLidEntries = item.contacts
                    .filter(c => c.id && c.lid)
                    .map(c => ({ lid: c.lid, jid: c.id }));
                if (contactLidEntries.length > 0) {
                    (0, WABinary_1.initLidPhoneMap)(contactLidEntries);
                }
            }

            for (const chat of item.conversations) {
                // ── Resolve chat.id: prefer pnJid (real phone JID) over @lid ──
                // If chat.id is @lid, resolve via pnJid. Never use @lid as chat identity.
                let chatId = chat.id;
                if ((0, WABinary_1.isLidUser)(chatId)) {
                    // Try pnJid from the conversation object first (authoritative)
                    const resolvedFromPn = chat.pnJid && (0, WABinary_1.isJidUser)(chat.pnJid) ? chat.pnJid : null;
                    // Try the lid map as fallback
                    const resolvedFromMap = resolvedFromPn || (0, WABinary_1.lidToJid)(chatId);
                    if (resolvedFromMap) {
                        chatId = resolvedFromMap;
                    }
                    // If still @lid and no resolution, skip this DM — we can't store it
                    // correctly without a real phone JID. Group chats never use @lid.
                    else if (!(0, WABinary_1.isJidGroup)(chatId)) {
                        continue;
                    }
                }

                // Push contact entry with all available identity info
                const contactEntry = {
                    id: chatId,
                    name: chat.name || undefined,
                    // Always store both lid and pnJid so callers can build their own maps
                    lid: chat.lidJid || ((0, WABinary_1.isLidUser)(chat.id) ? chat.id : undefined),
                    // jid = authoritative phone JID (for DMs)
                    jid: (0, WABinary_1.isJidUser)(chatId) ? chatId : ((0, WABinary_1.isJidUser)(chat.pnJid) ? chat.pnJid : undefined),
                };
                contacts.push(contactEntry);

                const msgs = chat.messages || [];
                delete chat.messages;
                delete chat.archived;
                delete chat.muteEndTime;
                delete chat.pinned;

                // Rewrite chat.id to resolved phone JID before pushing to chats
                const chatForStore = { ...chat, id: chatId };

                for (const item of msgs) {
                    const message = item.message;
                    // ── Resolve @lid in message keys ──
                    if (message.key) {
                        if ((0, WABinary_1.isLidUser)(message.key.remoteJid)) {
                            const resolved = (0, WABinary_1.lidToJid)(message.key.remoteJid);
                            if (resolved) message.key.remoteJid = resolved;
                            else message.key.remoteJid = chatId; // fallback to resolved chat JID
                        }
                        if (message.key.participant && (0, WABinary_1.isLidUser)(message.key.participant)) {
                            const resolved = (0, WABinary_1.lidToJid)(message.key.participant);
                            if (resolved) message.key.participant = resolved;
                            // else keep @lid — participant identity can be partially unknown
                        }
                    }
                    messages.push(message);
                    if (!((_a = chatForStore.messages) === null || _a === void 0 ? void 0 : _a.length)) {
                        // keep only the most recent message in the chat array
                        chatForStore.messages = [{ message }];
                    }
                    if (!message.key.fromMe && !chatForStore.lastMessageRecvTimestamp) {
                        chatForStore.lastMessageRecvTimestamp = (0, generics_1.toNumber)(message.messageTimestamp);
                    }
                    if ((message.messageStubType === Types_1.WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP
                        || message.messageStubType === Types_1.WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB)
                        && ((_b = message.messageStubParameters) === null || _b === void 0 ? void 0 : _b[0])) {
                        const participantRaw = message.key.participant || message.key.remoteJid;
                        contacts.push({
                            id: participantRaw,
                            verifiedName: (_c = message.messageStubParameters) === null || _c === void 0 ? void 0 : _c[0],
                        });
                    }
                }
                if ((0, WABinary_1.isJidUser)(chatId) && chatForStore.readOnly && chatForStore.archived) {
                    delete chatForStore.readOnly;
                }
                chats.push({ ...chatForStore });
            }
            break;
        case WAProto_1.proto.HistorySync.HistorySyncType.PUSH_NAME:
            for (const c of item.pushnames) {
                contacts.push({ id: c.id, notify: c.pushname });
            }
            break;
    }
    return {
        chats,
        contacts,
        messages,
        syncType: item.syncType,
        progress: item.progress
    };
};
exports.processHistoryMessage = processHistoryMessage;
const downloadAndProcessHistorySyncNotification = async (msg, options) => {
    const historyMsg = await (0, exports.downloadHistory)(msg, options);
    return (0, exports.processHistoryMessage)(historyMsg);
};
exports.downloadAndProcessHistorySyncNotification = downloadAndProcessHistorySyncNotification;
const getHistoryMsg = (message) => {
    var _a;
    const normalizedContent = !!message ? (0, messages_1.normalizeMessageContent)(message) : undefined;
    const anyHistoryMsg = (_a = normalizedContent === null || normalizedContent === void 0 ? void 0 : normalizedContent.protocolMessage) === null || _a === void 0 ? void 0 : _a.historySyncNotification;
    return anyHistoryMsg;
};
exports.getHistoryMsg = getHistoryMsg;
