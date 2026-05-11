'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OpenAI, toFile } = require('openai');
const logger = require('../config/logger');

let _openai = null;

function getOpenAI() {
    if (!_openai) {
        _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _openai;
}

/**
 * Descriptografa midia do WhatsApp usando AES-256-CBC + HKDF-SHA256.
 * Util para integracoes via webhook/CDN criptografado.
 */
function decryptWhatsAppMedia(encryptedData, mediaKeyB64, mediaType = 'Audio') {
    const mediaKey = Buffer.from(mediaKeyB64, 'base64');
    const info = Buffer.from(`WhatsApp ${mediaType} Keys`);

    const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(mediaKey).digest();

    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    for (let i = 1; okm.length < 112; i += 1) {
        const hmac = crypto.createHmac('sha256', prk);
        hmac.update(t);
        hmac.update(info);
        hmac.update(Buffer.from([i]));
        t = hmac.digest();
        okm = Buffer.concat([okm, t]);
    }

    okm = okm.slice(0, 112);
    const iv = okm.slice(0, 16);
    const cipherKey = okm.slice(16, 48);

    const ciphertext = encryptedData.slice(0, encryptedData.length - 10);
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    decipher.setAutoPadding(true);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function detectMediaType(message, media = null) {
    try {
        if (!message || !message.hasMedia) return 'text';

        const mimeType = String((media && media.mimetype) || message.type || '').toLowerCase();

        if (mimeType.includes('audio') || mimeType.includes('ptt')) return 'audio';
        if (mimeType.includes('video')) return 'video';
        if (mimeType.includes('image')) return 'image';
        if (mimeType.includes('pdf') || mimeType.includes('document')) return 'document';
        return 'unknown';
    } catch (err) {
        logger.warn(`[Media] Erro ao detectar midia: ${err.message}`);
        return 'unknown';
    }
}

async function transcribeAudio(message, preDownloadedMedia = null, outputDir = './temp_audio') {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const media = preDownloadedMedia || await message.downloadMedia();
    if (!media || !media.data) {
        throw new Error('Falha ao baixar arquivo de audio');
    }

    const ext = _guessAudioExtension(media.mimetype);
    const audioPath = path.join(outputDir, `audio_${Date.now()}.${ext}`);
    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(audioPath, buffer);

    try {
        const start = Date.now();
        const file = await toFile(buffer, `audio.${ext}`, { type: media.mimetype || 'audio/ogg' });

        const transcription = await getOpenAI().audio.transcriptions.create({
            file,
            model: 'whisper-1',
            response_format: 'verbose_json',
            temperature: 0.2
        });

        const latency = Date.now() - start;
        logger.info(`[Media] Audio transcrito em ${latency}ms`);

        return {
            text: String(transcription.text || '').trim(),
            language: transcription.language || 'unknown',
            confidence: 'high',
            transcriptionLatency: latency,
            media
        };
    } finally {
        if (fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
        }
    }
}

function createAudioContext(transcriptionData) {
    return [
        '[ANALISE DE AUDIO DO CLIENTE]',
        `- Texto transcrito: "${transcriptionData.text || ''}"`,
        `- Idioma detectado: ${transcriptionData.language || 'unknown'}`,
        `- Qualidade da transcricao: ${transcriptionData.confidence || 'unknown'}`,
        `- Tempo de processamento: ${transcriptionData.transcriptionLatency || 0}ms`,
        '',
        'Importante: Este texto veio de audio. Responda de forma humanizada, empatica e acolhedora.'
    ].join('\n').trim();
}

function _guessAudioExtension(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
    return 'ogg';
}

module.exports = {
    decryptWhatsAppMedia,
    detectMediaType,
    transcribeAudio,
    createAudioContext
};
