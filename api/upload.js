// api/upload.js — 포스터 이미지 업로드 (Vercel Blob)
// PUT /api/upload  (multipart/form-data, x-admin-key 헤더 필요)

import { put } from '@vercel/blob';

const ADMIN_KEY = process.env.ADMIN_KEY || 'bluebline2025';

export const config = {
  api: { bodyParser: false },  // 파일 업로드를 위해 bodyParser 비활성화
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-filename');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 인증
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY)
    return res.status(401).json({ success: false, message: '인증 실패' });

  if (req.method !== 'PUT' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const filename  = req.headers['x-filename'] || ('poster-' + Date.now() + '.jpg');
    const mimeType  = req.headers['content-type'] || 'image/jpeg';

    // 파일 크기 제한: 10MB
    const MAX_SIZE = 10 * 1024 * 1024;
    let size = 0;
    const chunks = [];

    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_SIZE) {
        return res.status(413).json({ success: false, message: '파일 크기는 10MB 이하여야 합니다.' });
      }
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);

    // Vercel Blob에 업로드
    const blob = await put('posters/' + filename, buffer, {
      access:      'public',
      contentType: mimeType,
      addRandomSuffix: true,
    });

    return res.status(200).json({
      success: true,
      url:     blob.url,
      filename: blob.pathname,
    });

  } catch(e) {
    console.error('업로드 오류:', e.message);
    return res.status(500).json({ success: false, message: '업로드 중 오류가 발생했습니다: ' + e.message });
  }
}
