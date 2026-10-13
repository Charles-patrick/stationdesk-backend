import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { bad } from '../utils/http.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 8)}`),
});

export const upload = multer({
  storage,
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(png|jpe?g|webp|gif|svg\+xml)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : bad('Upload an image or PDF (max 6 MB)'), ok);
  },
});

export const fileUrl = (file) => (file ? `${config.publicApiUrl}/uploads/${file.filename}` : null);
