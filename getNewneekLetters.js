import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';

function formatDuration(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mm = ms % 1000;
    return `${h}h ${m}m ${s}s ${mm}ms`;
  }

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

function getHourInZone(ms, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone });
    return Number(fmt.format(new Date(ms)));
  } catch (e) {
    // Fallback: approximate KST = UTC+9
    const h = new Date(ms + 9 * 60 * 60 * 1000).getUTCHours();
    return h;
  }
}

function isInKSTMorningWindow(ms) {
  const hour = getHourInZone(ms, 'Asia/Seoul');
  return hour >= 5 && hour <= 7; // 05:00 ~ 07:59
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
    config: { responseMimeType: 'text/plain', temperature: 0.3 },
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
    config: { responseMimeType: 'text/plain', temperature: 0.4 },
  });
  const out = res.text || '';
  if (!out) return '';
  if (koreanRatio(out) > 0.5) return '';
  return out.trim();
}

async function translateHtmlEndToEnd(html) {
  const prompt = [
    'You are a native English teacher. Take the following complete HTML email as input.',
    'Translate ALL visible Korean text into clear, natural English while PRESERVING the original HTML structure:',
    '- Keep all tags, nesting, classes, inline styles, images, links, and layout intact.',
    '- Replace only human‑readable text nodes; do not remove or add unrelated elements.',
    '- For each article/section, AFTER the translated content, append two subsections:',
    '  1) <h3>Vocabulary</h3> with a <ul class="vocab-list"> of 5–10 intermediate+ words, each with English–English definition and IPA.',
    '  2) <h3>Sentence Patterns</h3> with a <ul class="patterns"> of 2–4 key patterns and example sentences.',
    '- Proper nouns: "뉴닉" → "Newneek", "뉴니커" → "Newneekers".',
    'Return STRICTLY a valid HTML document starting with <html> and containing <head> and <body>. Do NOT include any explanations or markdown.',
    '',
    html,
  ].join('\n');
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'text/plain', temperature: 0.4 },
  });
  const out = res.text || '';
  // 모델이 text/plain으로 내보내므로, 유효한 HTML 문서로 재래핑
  if (!out) return '';
  const { head: headOrig } = extractHeadAndBody(html);
  const bodySanitized = out; // 신뢰 가정; 필요시 추가 sanitize 가능
  return `<html><head>${headOrig || ''}</head><body>${bodySanitized}</body></html>`;
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
    const q = 'from:newneek.co newer_than:1d';

    // 내 이메일 주소 알아내기 (발송용)
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const myEmail = profile.data.emailAddress;

    let pageToken = undefined;
    const results = [];
    let page = 0;
    let totalCandidates = 0;
    let sentCount = 0;
    let skippedCount = 0;
    const startedTime = new Date;
    console.log('[translator] Start', { hasKey: Boolean(process.env.GEMINI_API_KEY), query: q });
    console.log('Started', startedTime);

    do {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q,
            maxResults: 20,
            pageToken,
        });

        const ids = (res.data.messages || []).map(m => m.id);
        console.log(`[translator] Page ${++page}: ids=${ids.length}`);
        if (ids.length === 0) {
            pageToken = res.data.nextPageToken;
            continue;
        }
        totalCandidates += ids.length;

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
            // 오전 5~7시(KST) 도착분만 처리
            const internalDateMs = Number(d.data.internalDate || 0);
            if (!isInKSTMorningWindow(internalDateMs)) {
                console.log('[translator] Skip (time window)', d.data.id, new Date(internalDateMs).toISOString());
                continue;
            }
            const originalSubject = pick('Subject') || '(No Subject)';
            console.log('[translator] Candidate', d.data.id, '-', originalSubject);

            let bodyText = '';
            let bodyHtml = undefined;
            let translated = '';
            let shouldSend = true;

            if (textHtml) {
                // 상단: 교사모드(영어) 섹션, 본문: 태그 보존 영어 번역. 한국어 원문은 포함하지 않음
                const src = textHtml;
                const asText = stripHtml(src);
                if (process.env.GEMINI_API_KEY) {
                    try {
                        // 통째 변환(교사모드 포함). 실패 시 전송하지 않음
                        const full = await translateHtmlEndToEnd(src);
                        if (full) {
                            bodyHtml = full;
                            translated = stripHtml(full);
                            bodyText = stripHtml(full);
                        } else {
                            console.error('[translator] E2E HTML translation returned empty. Skip send.');
                            shouldSend = false;
                        }
                    } catch (e) {
                        console.error('[translator] E2E HTML translation error. Skip send:', e?.message || e);
                        shouldSend = false;
                    }
                } else {
                    console.error('[translator] GEMINI_API_KEY missing. Skip send for HTML message.');
                    shouldSend = false;
                }
            } else {
                const src = textPlain || d.data.snippet || '';
                if (process.env.GEMINI_API_KEY) {
                    try {
                        // 텍스트만: 교사모드 HTML을 생성하여 완전한 문서로 전송. 실패 시 전송하지 않음
                        const teachingOnly = await translateTeachingHtml(src);
                        if (teachingOnly) {
                            const { head, body } = extractHeadAndBody(teachingOnly);
                            bodyHtml = `<html><head>${head}</head><body>${body}</body></html>`;
                            translated = stripHtml(body);
                            bodyText = translated;
                        } else {
                            const t = await translateToEnglish(src);
                            if (t) {
                                const simple = `<div class=\"article-body\" style=\"white-space: pre-wrap;\">${escapeHtml(t).replace(/\n/g, '<br/>')}</div>`;
                                bodyHtml = `<html><body>${simple}</body></html>`;
                                translated = t;
                                bodyText = t;
                            } else {
                                console.error('[translator] Plain text translation empty. Skip send.');
                                shouldSend = false;
                            }
                        }
                    } catch (e) {
                        console.error('[translator] Text translation error. Skip send:', e?.message || e);
                        shouldSend = false;
                    }
                } else {
                    console.error('[translator] GEMINI_API_KEY missing. Skip send for text message.');
                    shouldSend = false;
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
            if (shouldSend && bodyHtml) {
                try {
                    console.log('[translator] Sending', d.data.id, '-', subjectToSend);
                    await sendMail(auth, {
                        to: myEmail,
                        from: myEmail,
                        subject: `[NEWNEEK-EN] ${subjectToSend}`,
                        bodyText,
                        bodyHtml,
                    });
                    sentCount += 1;
                    console.log('[translator] Sent', d.data.id);
                } catch (e) {
                    console.error('sendMail failed:', e?.message || e);
                }
            } else {
                console.error('[translator] Skipped send for message:', {
                    id: d.data.id,
                    subject: originalSubject,
                });
                skippedCount += 1;
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

    const finishedTime = new Date;
    const duration = finishedTime - startedTime;
    console.log('[translator] Done', { duration: formatDuration(duration), pages: page, candidates: totalCandidates, sent: sentCount, skipped: skippedCount });
    return results;
}