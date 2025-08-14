import 'dotenv/config';
import getGmail from './getGmail.js'

async function getMail() {
    let msg = await getGmail();
    console.log('🚨', msg);
}

// 설명: 키 주입이 되었는지 런타임에서 바로 체크 다나까
console.log('gemini key?', !!process.env.GEMINI_API_KEY);

getMail();