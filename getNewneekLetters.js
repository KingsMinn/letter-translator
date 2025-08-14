import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';

function decodeBase64Url(data){
    if (!data) return '';
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf-8');
}

function encodeBase64Url(str) {
    return Buffer.from(str, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeRFC2047(subject) {
    if (!subject) return '';
    const b64 = Buffer.from(subject, 'utf-8').toString('base64');
    return `=?UTF-8?B?${b64}?=`;
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function koreanRatio(str) {
    if (!str) return 0;
    const hanguls = str.match(/[\u3131-\uD79D]/g);
    return hanguls ? (hanguls.length / str.length) : 0;
}

function cleanModelOutput(text) {
    if (!text) return '';
    let out = text.trim();
    // Remove code fences
    out = out.replace(/^```[a-zA-Z0-9]*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
    // Drop common prefaces on the first line
    out = out.replace(/^\s*(here\s+is|here's|below\s+is|translated|translation)[:\-\s]+/i, '');
    // If still starts with markdown heading, remove leading # and spaces
    out = out.replace(/^\s*#{1,6}\s+/g, '');
    return out.trim();
}

function extractHeadAndBody(html) {
  if (!html) return { head: '', body: html || '' };
  let head = '';
  let body = html;
  // Strip DOCTYPE
  body = body.replace(/<!DOCTYPE[\s\S]*?>/i, '').trim();
  // Extract <head>
  const headMatch = body.match(/<head[\s\S]*?>([\s\S]*?)<\/head>/i);
  if (headMatch) {
    head = headMatch[1];
  }
  // Extract <body>
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    body = bodyMatch[1];
  } else {
    // If there's <html> wrapper, remove it
    body = body.replace(/<\/?html[^>]*>/gi, '');
  }
  return { head, body };
}

function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
}

function extractBodies(payload) {
    let textPlain = '';
    let textHtml = '';

    function walk(part) {
        if (!part) return;
        const { mimeType, body, parts } = part;
        if (mimeType === 'text/plain' && body?.data) textPlain += decodeBase64Url(body.data);
        else if (mimeType === 'text/html' && body?.data) textHtml += decodeBase64Url(body.data);
        (parts || []).forEach(walk);
    }
    if (payload?.body?.data && (!payload.parts || payload.parts.length === 0)) {
        const data = decodeBase64Url(payload.body.data);
        if ((payload.mimeType || '').toLowerCase().includes('text/html')) {
            textHtml = data;
        } else {
            textPlain = data;
        }
    } else {
        walk(payload);
    }
    return { textPlain, textHtml };
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function translateToEnglish(text) {
  const prompt = [
    'Translate the Korean text into clear, concise English.',
    'Return ONLY the translation text.',
    'Do NOT add any introductions, notes, markdown, or code fences.',
    'Preserve paragraph breaks.',
    '',
    text,
  ].join('\n');
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'text/plain', temperature: 0.3 },
  });
  return cleanModelOutput(res.text || '');
}

async function translateToEnglishHtml(html) {
  const prompt = [
    'Translate the following HTML email content into clear, concise English.',
    'Preserve ALL HTML tags, attributes, links, classes, and inline styles.',
    'Translate ONLY human-readable text nodes. Do not remove or add elements.',
    'Return only the translated HTML without any extra commentary or markdown.',
    '',
    html,
  ].join('\n');
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'text/html', temperature: 0.3 },
  });
  const out = res.text || '';
  // 번역 실패/미변환으로 판단되면 빈 문자열 반환하여 상위에서 폴백 처리
  if (!out) return '';
  if (koreanRatio(out) > 0.3) return '';
  if (out.length < 20 && koreanRatio(html) > 0.3) return '';
  return out;
}

async function translateTeachingHtml(text) {
  const prompt = [
    'You are a native English teacher helping the user study English.',
    'The user uploads one or more Korean news articles (short paragraphs). Convert each article into natural English, matching its tone and style.',
    'After each translated article, add two sections: Vocabulary (intermediate level or above; provide English-English definition and IPA pronunciation) and Sentence Patterns (important structures from the article).',
    'Translate proper nouns: "뉴닉" -> "Newneek", "뉴니커" -> "Newneekers".',
    'Ordering must be: 사회 기사 → Vocabulary → Sentence Patterns → 경제 기사 → Vocabulary → Sentence Patterns → ... following the original order.',
    'Output strictly HTML only (no markdown, no explanations). Use this structure for each article:',
    '<section class="article">',
    '  <h2 class="article-title">[English title or topic]</h2>',
    '  <div class="article-body">[Translated article in English with paragraphs]</div>',
    '  <h3>Vocabulary</h3>',
    '  <ul class="vocab-list">',
    '    <li><span class="word">word</span> <span class="ipa">/ˈwɜːd/</span> — <span class="def">English definition</span></li>',
    '  </ul>',
    '  <h3>Sentence Patterns</h3>',
    '  <ul class="patterns">',
    '    <li><span class="pattern">pattern</span> — <span class="ex">Example sentence</span></li>',
    '  </ul>',
    '</section>',
    'Return only the HTML fragment (no wrapper text).',
    '',
    text,
  ].join('\n');
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'text/html', temperature: 0.4 },
  });
  const out = res.text || '';
  if (!out) return '';
  if (koreanRatio(out) > 0.5) return '';
  return out.trim();
}

function buildMime({ to, from, subject, bodyText, bodyHtml }) {
    const boundary = 'mime-boundary-12345';
    const encodedSubject = encodeRFC2047(subject);
    if (bodyHtml) {
      const textPartB64 = Buffer.from(bodyText || '', 'utf-8').toString('base64');
      const htmlPartB64 = Buffer.from(bodyHtml || '', 'utf-8').toString('base64');
      const mime = [
        'MIME-Version: 1.0', `To: ${to}`, `From: ${from}`, `Subject: ${encodedSubject}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', textPartB64,
        `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', htmlPartB64,
        `--${boundary}--`, ''
      ].join('\r\n');
      return encodeBase64Url(mime);
    }
    const textOnlyB64 = Buffer.from(bodyText || '', 'utf-8').toString('base64');
    const mime = [
      'MIME-Version: 1.0', `To: ${to}`, `From: ${from}`, `Subject: ${encodedSubject}`,
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', textOnlyB64, ''
    ].join('\r\n');
    return encodeBase64Url(mime);
  }
  async function sendMail(auth, { to, from, subject, bodyText, bodyHtml }) {
    const gmail = google.gmail({ version: 'v1', auth });
    const raw = buildMime({ to, from, subject, bodyText, bodyHtml });
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  }

export default async function getNewneekLetters(auth) {
    const gmail = google.gmail({ version: 'v1', auth });

    // 뉴닉 필터: 도메인 기준 + 최신 몇 시간만 + 안 읽은 메일 우선
    const q = 'from:newneek.co subject:"🦔" newer_than:1d';

    // 내 이메일 주소 알아내기 (발송용)
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const myEmail = profile.data.emailAddress;

    let pageToken = undefined;
    const results = [];

    do {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q,
            maxResults: 20,
            pageToken,
        });

        const ids = (res.data.messages || []).map(m => m.id);
        if (ids.length === 0) {
            pageToken = res.data.nextPageToken;
            continue;
        }

        const details = await Promise.all(
            ids.map(id =>
                gmail.users.messages.get({
                    userId: 'me',
                    id,
                    format: 'FULL',
                })
            )
        );

        for (const d of details) {
            const headers = d.data.payload.headers || [];
            const pick = name => headers.find(h => h.name === name)?.value || '';
            const { textPlain, textHtml } = extractBodies(d.data.payload);
            const originalSubject = pick('Subject') || '(No Subject)';

            let bodyText = '';
            let bodyHtml = undefined;
            let translated = '';

            if (textHtml) {
                // 상단: 교사모드(영어) 섹션, 본문: 태그 보존 영어 번역. 한국어 원문은 포함하지 않음
                const src = textHtml;
                const asText = stripHtml(src);
                if (process.env.GEMINI_API_KEY) {
                    try {
                        const teaching = await translateTeachingHtml(asText); // HTML fragment
                        const translatedBody = await translateToEnglishHtml(src); // HTML body
                        const safeTeaching = teaching || '';
                        const safeBodyRaw = translatedBody || `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(await translateToEnglish(asText)).replace(/\n/g, '<br/>')}</div>`;
                        const { head: head1, body: body1 } = extractHeadAndBody(safeTeaching);
                        const { head: head2, body: body2 } = extractHeadAndBody(safeBodyRaw);
                        const head = [head1, head2].filter(Boolean).join('\n');
                        const bodyCombined = `${body1}${body2}`;
                        translated = stripHtml(bodyCombined);
                        bodyHtml = `<html><head>${head}</head><body>${bodyCombined}</body></html>`;
                        bodyText = stripHtml(bodyCombined);
                    } catch (e) {
                        // 폴백: 영어 텍스트만
                        const t = await translateToEnglish(asText).catch(() => asText);
                        const simple = `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(t).replace(/\n/g, '<br/>')}</div>`;
                        translated = t;
                        bodyHtml = `<html><body>${simple}</body></html>`;
                        bodyText = t;
                    }
                } else {
                    // 키 없음: 처리 불가 → 원문 제외, 빈 본문 방지용 최소 블록
                    const t = asText;
                    const simple = `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(t).replace(/\n/g, '<br/>')}</div>`;
                    translated = t;
                    bodyHtml = `<html><body>${simple}</body></html>`;
                    bodyText = t;
                }
            } else {
                const src = textPlain || d.data.snippet || '';
                if (process.env.GEMINI_API_KEY) {
                    try {
                        // 텍스트만 있는 경우: Teaching HTML + 영어 본문 텍스트
                        let teaching = await translateTeachingHtml(src);
                        let t = await translateToEnglish(src);
                        const safeTeaching = teaching || '';
                        const simpleBody = `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(t).replace(/\n/g, '<br/>')}</div>`;
                        translated = t;
                        bodyHtml = `<html><body>${safeTeaching}${simpleBody}</body></html>`;
                        bodyText = stripHtml(`${safeTeaching}${simpleBody}`);
                    } catch (e) {
                        translated = src;
                        const simple = `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(translated).replace(/\n/g, '<br/>')}</div>`;
                        bodyHtml = `<html><body>${simple}</body></html>`;
                        bodyText = translated;
                    }
                } else {
                    translated = src;
                    const simple = `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(translated).replace(/\n/g, '<br/>')}</div>`;
                    bodyHtml = `<html><body>${simple}</body></html>`;
                    bodyText = translated;
                }
            }

            // 제목 영어 번역 시도 후 채택
            let subjectToSend = originalSubject;
            if (process.env.GEMINI_API_KEY) {
                try {
                    const tSubj = await translateToEnglish(originalSubject);
                    if (tSubj && koreanRatio(tSubj) < 0.3) subjectToSend = tSubj;
                } catch {}
            }

            // 발송 (번역된 본문을 나에게 전송)
            try {
                await sendMail(auth, {
                    to: myEmail,
                    from: myEmail,
                    subject: `[NEWNEEK-EN] ${subjectToSend}`,
                    bodyText,
                    bodyHtml,
                });
            } catch (e) {
                console.error('sendMail failed:', e?.message || e);
            }

            results.push({
                id: d.data.id,
                threadId: d.data.threadId,
                subject: originalSubject,
                from: pick('From'),
                date: pick('Date'),
                textPlain,
                textHtml,
                translated,
            });
        }

        pageToken = res.data.nextPageToken;
    } while (pageToken);

    return results;
}