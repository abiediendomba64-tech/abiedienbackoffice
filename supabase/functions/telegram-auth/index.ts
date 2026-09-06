import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token',
};

// Telegram Endpoints
interface ClaimRow {
  id: string;
  telegram_user_id: string | number;
  claim_type: string;
  status: string;
  notes: string | null;
  evidence_path: string | null;
  created_at: string;
}

const TELEGRAM_TOKEN_ENDPOINT = 'https://oauth.telegram.org/auth/request';
const TELEGRAM_JWKS_ENDPOINT = 'https://oauth.telegram.org/keys';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

const HINTS = {
  welcome_guest: `👋 *Selamat Datang di Abiedien System*

Sistem ini menerapkan *Zero Trust & Private Consultation Hierarchy*.
Untuk mengakses fitur member dan layanan operasional, silakan lakukan registrasi.

⚠️ *Peringatan Keamanan Cyber:*
• Hindari oknum yang mengatasnamakan admin/dev.
• Komunikasi konsultasi bersifat privat dan terenkripsi.
• Pengajuan klaim gaji *WAJIB* menyertakan bukti screenshot transaksi asli.`,

  welcome_member: `🛡️ *Member Portal Dashboard*

Status Akun: ✅ *Aktif (Verified Member)*
Konsultan Admin Anda siap membantu secara privat.

Silakan pilih menu di bawah:`,

  welcome_admin: `👑 *Super Admin & Dev Command Center*

Status: 🟢 *Super Admin Authorized*
Chat ID Anda telah tersinkronisasi untuk menerima notifikasi klaim & darurat.

Ketik \`/admin help\` untuk melihat daftar perintah kontrol hirarki.`,

  security_rules: `📜 *Aturan Pakai & Hint Keamanan Nyata:*

1. *Klaim Gaji & Payout:*
   • Hanya menerima lampiran foto/screenshot asli (Maks 5 MB).
   • Dokumen/video/teks tanpa screenshot akan otomatis ditolak.
   • Maksimal 3 klaim per 24 jam.
2. *Anti-Phishing & Cyber Defense:*
   • Admin resmi *TIDAK PERNAH* meminta password atau OTP Anda.
   • Hubungi Admin Resmi terverifikasi via tombol konsultasi privat.
3. *Audit & Logging:*
   • Semua aktivitas dicatat dalam sistem audit trail demi keamanan bersama.`,

  claim_prompt: `📸 *Pengajuan Klaim Gaji / Payout*

Silakan kirimkan *FOTO SCREENSHOT BUKTI* (Maks 5 MB) yang jelas.
Sertakan keterangan nominal/pekerjaan pada caption foto.

_Format selain foto akan ditolak oleh sistem._`,

  not_registered: `🚫 *Akses Ditolak: Anda Belum Terdaftar*

Anda belum memiliki status sebagai member aktif.
Silakan klik tombol *Daftar Member* di bawah untuk memulai proses registrasi.`,

  admin_help: `🛠️ *Daftar Perintah Super Admin:*

• \`/admin claims\` — Cek daftar klaim pending
• \`/admin promote <tg_id>\` — Naikkan status ke Admin
• \`/admin demote <tg_id>\` — Turunkan status ke Member
• \`/admin block <tg_id>\` — Blokir user Telegram
• \`/admin unblock <tg_id>\` — Buka blokir user Telegram`
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function verifyTelegramJWT(idToken: string): Promise<Record<string, any>> {
  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('Invalid JWT format');

  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
  const jwksRes = await fetch(TELEGRAM_JWKS_ENDPOINT);
  if (!jwksRes.ok) throw new Error('Failed to fetch Telegram JWKS');
  const { keys }: { keys: JsonWebKey[] } = await jwksRes.json();
  
  const jwk = (keys as any[]).find(k => k.kid === header.kid) ?? keys[0];
  if (!jwk) throw new Error('No matching JWK found');

  const publicKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );

  const encoder = new TextEncoder();
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToArrayBuffer(signatureB64);

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, data);
  if (!valid) throw new Error('JWT signature verification failed');

  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('JWT token expired');

  return payload;
}

async function verifyTelegramHMAC(telegramPayload: Record<string, any>, botToken: string): Promise<boolean> {
  const { hash, ...dataToVerify } = telegramPayload;
  if (!hash) return false;

  // Freshness check: Reject if auth_date is older than 24 hours
  if (dataToVerify.auth_date) {
    const authDate = parseInt(dataToVerify.auth_date, 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) return false;
  }

  const dataCheckArr = [];
  for (const key of Object.keys(dataToVerify).sort()) {
    dataCheckArr.push(`${key}=${dataToVerify[key]}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const encoder = new TextEncoder();
  const secretKeyData = await crypto.subtle.digest('SHA-256', encoder.encode(botToken));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', secretKeyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(dataCheckString));
  const signatureHex = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return constantTimeEqual(signatureHex, String(hash));
}

// Telegram Bot API Helper
async function sendTelegramMessage(botToken: string, chatId: number | string, text: string, replyMarkup?: any) {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
  return res.json();
}

// ----------------------------------------------------
// Strict Environment Validation (Fail Closed)
// ----------------------------------------------------
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
const rawSuperAdminIds = Deno.env.get('SUPER_ADMIN_IDS');
const clientId = Deno.env.get('TELEGRAM_CLIENT_ID');
const clientSecret = Deno.env.get('TELEGRAM_CLIENT_SECRET');

if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
if (!supabaseServiceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
if (!rawSuperAdminIds) throw new Error("SUPER_ADMIN_IDS is required");

const superAdminIds = rawSuperAdminIds
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const rawBody = await req.text();
    let body: any = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // non-json or empty
      }
    }

    // ==========================================
    // 1. TELEGRAM WEBHOOK HANDLER
    // ==========================================
    if (body.update_id) {
      const incomingSecretToken = req.headers.get('x-telegram-bot-api-secret-token');
      if (incomingSecretToken !== webhookSecret) {
        return new Response(JSON.stringify({ error: 'Unauthorized webhook secret' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const updateId = body.update_id;

      // Idempotency check
      const { data: existingUpdate } = await supabaseAdmin
        .from('telegram_updates')
        .select('update_id')
        .eq('update_id', updateId)
        .maybeSingle();

      if (existingUpdate) {
        return new Response(JSON.stringify({ status: 'already_processed' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      await supabaseAdmin.from('telegram_updates').insert([{ update_id: updateId }]);

      const message = body.message;
      const callbackQuery = body.callback_query;
      const sender = message?.from || callbackQuery?.from;
      const chatId = message?.chat?.id || callbackQuery?.message?.chat?.id;

      if (!sender || !chatId) {
        return new Response(JSON.stringify({ status: 'no_sender' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const senderIdStr = String(sender.id);
      const isSuperAdmin = superAdminIds.includes(senderIdStr);
      const senderName = `${sender.first_name || ''} ${sender.last_name || ''}`.trim() || sender.username || `User ${sender.id}`;

      // Automatically register / update admin_chat_ids and telegram_users for Super Admins
      if (isSuperAdmin) {
        await supabaseAdmin.from('admin_chat_ids').upsert({
          telegram_user_id: sender.id,
          chat_id: chatId,
          display_name: senderName,
          is_active: true,
          updated_at: new Date().toISOString()
        });

        await supabaseAdmin.from('telegram_users').upsert({
          telegram_user_id: sender.id,
          telegram_chat_id: chatId,
          telegram_username: sender.username,
          display_name: senderName,
          role: 'super_admin',
          status: 'active',
          updated_at: new Date().toISOString()
        }, { onConflict: 'telegram_user_id' });
      }

      // Fetch or initialize user in telegram_users
      let { data: tgUser } = await supabaseAdmin
        .from('telegram_users')
        .select('*')
        .eq('telegram_user_id', sender.id)
        .maybeSingle();

      if (!tgUser) {
        const { data: newUser } = await supabaseAdmin
          .from('telegram_users')
          .insert([{
            telegram_user_id: sender.id,
            telegram_chat_id: chatId,
            telegram_username: sender.username,
            display_name: senderName,
            role: isSuperAdmin ? 'super_admin' : 'guest',
            status: isSuperAdmin ? 'active' : 'pending',
            assigned_admin_id: 7862805424 // Default main admin consultant
          }])
          .select()
          .single();
        tgUser = newUser;
      }

      // ------------------------------------------
      // A. CALLBACK QUERY ACTIONS
      // ------------------------------------------
      if (callbackQuery) {
        const data = callbackQuery.data;

        if (data === 'btn_register') {
          await sendTelegramMessage(botToken, chatId, 
            `📝 *Form Pendaftaran Member*\n\nSilakan balas pesan ini dengan format:\n\`REG#Nama Lengkap#Email Anda\`\n\nContoh:\n\`REG#Budi Santoso#budi@gmail.com\``
          );
        } else if (data === 'btn_claim_prompt') {
          if (tgUser?.role !== 'member' && !isSuperAdmin) {
            await sendTelegramMessage(botToken, chatId, HINTS.not_registered, {
              inline_keyboard: [[{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }]]
            });
          } else {
            await sendTelegramMessage(botToken, chatId, HINTS.claim_prompt);
          }
        } else if (data === 'btn_rules') {
          await sendTelegramMessage(botToken, chatId, HINTS.security_rules);
        }

        return new Response(JSON.stringify({ status: 'callback_handled' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ------------------------------------------
      // B. PHOTO UPLOAD (EVIDENCE CLAIM)
      // ------------------------------------------
      if (message.photo && message.photo.length > 0) {
        if (tgUser?.role !== 'member' && !isSuperAdmin) {
          await sendTelegramMessage(botToken, chatId, HINTS.not_registered, {
            inline_keyboard: [[{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }]]
          });
          return new Response(JSON.stringify({ status: 'claim_rejected_not_member' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Rate limit check
        const { data: rateLimitCheck } = await supabaseAdmin.rpc('check_claim_rate_limit', {
          p_telegram_user_id: sender.id,
          p_claim_type: 'salary'
        });

        if (rateLimitCheck && rateLimitCheck.allowed === false) {
          await sendTelegramMessage(botToken, chatId, `⚠️ *Pengajuan Klaim Ditolak:*\n${rateLimitCheck.reason}`);
          return new Response(JSON.stringify({ status: 'rate_limited' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Highest resolution photo
        const bestPhoto = message.photo[message.photo.length - 1];
        if (bestPhoto.file_size && bestPhoto.file_size > 5 * 1024 * 1024) {
          await sendTelegramMessage(botToken, chatId, '⚠️ Ukuran foto melebihi batas 5 MB. Silakan kompres atau kirim foto dengan resolusi lebih ringkas.');
          return new Response(JSON.stringify({ status: 'file_too_large' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Fetch file path from Telegram Bot API
        const fileInfoRes = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
        const fileInfo = await fileInfoRes.json();
        
        if (!fileInfo.ok || !fileInfo.result?.file_path) {
          await sendTelegramMessage(botToken, chatId, '❌ Gagal mengunduh berkas dari Telegram. Silakan coba kirim ulang.');
          return new Response(JSON.stringify({ status: 'download_failed' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${botToken}/${fileInfo.result.file_path}`;
        const fileBuffer = await (await fetch(downloadUrl)).arrayBuffer();
        const storagePath = `claims/${sender.id}/${Date.now()}_${bestPhoto.file_id.substring(0, 8)}.jpg`;

        // Upload to private bucket claim-evidence
        const { error: storageError } = await supabaseAdmin.storage
          .from('claim-evidence')
          .upload(storagePath, fileBuffer, {
            contentType: 'image/jpeg',
            upsert: false
          });

        if (storageError) {
          console.warn('Storage upload note:', storageError);
        }

        // Create claim record
        const caption = message.caption || 'Klaim gaji diajukan via Telegram Bot';
        const { data: newClaim, error: claimError } = await supabaseAdmin
          .from('claims')
          .insert([{
            telegram_user_id: sender.id,
            claim_type: 'salary',
            notes: caption,
            evidence_path: storagePath,
            status: 'pending',
            assigned_admin_id: tgUser.assigned_admin_id || 7862805424
          }])
          .select()
          .single();

        if (claimError) {
          await sendTelegramMessage(botToken, chatId, `❌ Gagal mencatat klaim ke database: ${claimError.message}`);
        } else {
          await sendTelegramMessage(botToken, chatId, 
            `✅ *Bukti Klaim Berhasil Diterima!*\n\nID Klaim: \`#CLM-${newClaim?.id?.substring(0, 8)}\`\nStatus: ⏳ *Dalam Antrean Review*\nKonsultan: ID #${tgUser.assigned_admin_id || '7862805424'}\n\nNotifikasi telah dikirimkan secara privat ke admin verifikator.`
          );

          // Notify assigned Admin privately
          const assignedAdminId = tgUser.assigned_admin_id || 7862805424;
          const { data: adminRecord } = await supabaseAdmin
            .from('admin_chat_ids')
            .select('chat_id')
            .eq('telegram_user_id', assignedAdminId)
            .maybeSingle();

          const adminTargetChatId = adminRecord?.chat_id || 7862805424;
          if (adminTargetChatId && botToken) {
            await sendTelegramMessage(botToken, adminTargetChatId, 
              `🔔 *NOTIFIKASI KLAIM BARU*\n\nMember: *${senderName}* (ID: \`${sender.id}\`)\nKeterangan: _${caption}_\nID Klaim: \`${newClaim?.id}\`\nStatus: Pending Verification\n\nBuka dashboard untuk verifikasi dan generate signed preview URL.`
            );
          }
        }

        return new Response(JSON.stringify({ status: 'photo_processed' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ------------------------------------------
      // C. TEXT COMMANDS & REGISTRATION PARSER
      // ------------------------------------------
      const text = (message.text || '').trim();

      // Check for Registration submission format: REG#Name#Email
      if (text.startsWith('REG#')) {
        const parts = text.split('#');
        if (parts.length >= 3) {
          const regName = parts[1].trim();
          const regEmail = parts[2].trim().toLowerCase();

          if (!regEmail.includes('@')) {
            await sendTelegramMessage(botToken, chatId, '⚠️ Format email tidak valid. Pastikan menuliskan email dengan benar.');
            return new Response(JSON.stringify({ status: 'invalid_email' }), { status: 200 });
          }

          // Pendaftaran langsung via Telegram (Tanpa mencampur dengan auth.users lama)
          await supabaseAdmin.from('telegram_users').update({
            display_name: regName,
            email: regEmail,
            status: 'active',
            role: 'member',
            updated_at: new Date().toISOString()
          }).eq('telegram_user_id', sender.id);

          await sendTelegramMessage(botToken, chatId, 
            `✅ *Pendaftaran Berhasil!*\n\nSelamat datang *${regName}*, akun Anda kini telah aktif sebagai *Member*.\nAnda dapat mulai berinteraksi dengan bot dan mengajukan klaim gaji.`
          );
          return new Response(JSON.stringify({ status: 'reg_submitted' }), { status: 200 });
        }
      }

      // /start command
      if (text.startsWith('/start')) {
        if (isSuperAdmin) {
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_admin, {
            inline_keyboard: [
              [{ text: '📊 Cek Status Bot', callback_data: 'btn_rules' }],
              [{ text: '🛠️ Perintah Admin', callback_data: 'btn_admin_help' }]
            ]
          });
        } else if (tgUser?.role === 'member' && tgUser?.status === 'active') {
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_member, {
            inline_keyboard: [
              [{ text: '📸 Ajukan Klaim Gaji', callback_data: 'btn_claim_prompt' }],
              [{ text: '💬 Hubungi Konsultan Admin', url: `tg://user?id=${tgUser.assigned_admin_id || 7862805424}` }],
              [{ text: 'ℹ️ Aturan & Hint Keamanan', callback_data: 'btn_rules' }]
            ]
          });
        } else {
          await sendTelegramMessage(botToken, chatId, HINTS.welcome_guest, {
            inline_keyboard: [
              [{ text: '📝 Daftar Member Baru', callback_data: 'btn_register' }],
              [{ text: 'ℹ️ Aturan & Panduan Keamanan', callback_data: 'btn_rules' }]
            ]
          });
        }
        return new Response(JSON.stringify({ status: 'start_handled' }), { status: 200 });
      }

      // /help & /hint
      if (text === '/help' || text === '/hint') {
        await sendTelegramMessage(botToken, chatId, HINTS.security_rules);
        return new Response(JSON.stringify({ status: 'help_handled' }), { status: 200 });
      }

      // Admin commands
      if (text.startsWith('/admin')) {
        if (!isSuperAdmin) {
          await sendTelegramMessage(botToken, chatId, '⛔ *Akses Ditolak:* Perintah ini khusus untuk Super Admin.');
          return new Response(JSON.stringify({ status: 'admin_denied' }), { status: 200 });
        }

        const args = text.split(' ').filter(Boolean);
        const subCommand = args[1];

        if (!subCommand || subCommand === 'help') {
          await sendTelegramMessage(botToken, chatId, HINTS.admin_help);
        } else if (subCommand === 'claims') {
          const { data: pendingClaims } = await supabaseAdmin
            .from('claims')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(5);

          if (!pendingClaims || pendingClaims.length === 0) {
            await sendTelegramMessage(botToken, chatId, '✅ Tidak ada klaim pending saat ini.');
          } else {
            let msg = '📋 *Daftar Klaim Pending:*\n\n';
            pendingClaims.forEach((c: ClaimRow) => {
              msg += `• ID: \`#CLM-${c.id.substring(0, 8)}\` | User: \`${c.telegram_user_id}\`\n  Ket: ${c.notes || '-'}\n\n`;
            });
            await sendTelegramMessage(botToken, chatId, msg);
          }
        } else if (subCommand === 'promote' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ role: 'admin', status: 'active' }).eq('telegram_user_id', targetTgId);
          await sendTelegramMessage(botToken, chatId, `✅ User Telegram ID \`${targetTgId}\` berhasil dipromosikan menjadi Admin.`);
        } else if (subCommand === 'demote' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ role: 'member' }).eq('telegram_user_id', targetTgId);
          await sendTelegramMessage(botToken, chatId, `✅ User Telegram ID \`${targetTgId}\` berhasil diturunkan menjadi Member.`);
        } else if (subCommand === 'block' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ status: 'blocked' }).eq('telegram_user_id', targetTgId);
          await sendTelegramMessage(botToken, chatId, `⛔ User Telegram ID \`${targetTgId}\` telah DIBLOKIR.`);
        } else if (subCommand === 'unblock' && args[2]) {
          const targetTgId = Number(args[2]);
          await supabaseAdmin.from('telegram_users').update({ status: 'active' }).eq('telegram_user_id', targetTgId);
          await sendTelegramMessage(botToken, chatId, `✅ User Telegram ID \`${targetTgId}\` telah diaktifkan kembali.`);
        }

        return new Response(JSON.stringify({ status: 'admin_handled' }), { status: 200 });
      }

      // Default fallback message
      await sendTelegramMessage(botToken, chatId, 
        `💡 Ketik \`/start\` untuk membuka menu utama, atau \`/help\` untuk panduan & hint keamanan.`
      );
      return new Response(JSON.stringify({ status: 'default_handled' }), { status: 200 });
    }

    // ==========================================
    // 2. LINK TELEGRAM AUTH ENDPOINT (from Frontend)
    // ==========================================
    if (body.action === 'link_telegram' && body.telegram_id && body.email) {
      const { data: updatedUser, error: updateErr } = await supabaseAdmin
        .from('telegram_users')
        .update({
          email: body.email,
          display_name: body.display_name || 'Member Terverifikasi',
          role: 'member',
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('telegram_user_id', Number(body.telegram_id))
        .select()
        .single();

      if (updateErr) throw updateErr;

      return new Response(JSON.stringify({ success: true, user: updatedUser }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ==========================================
    // 3. WEB APP OPERATOR AUTH (OIDC / Login Widget)
    // ==========================================
    let telegramId: string | number | undefined;

    if (body.code) {
      const clientId = Deno.env.get('TELEGRAM_CLIENT_ID');
      const clientSecret = Deno.env.get('TELEGRAM_CLIENT_SECRET');
      const redirectUri = Deno.env.get('TELEGRAM_REDIRECT_URI') ?? 'https://abiedienbackoffice.pages.dev/';

      if (!clientId || !clientSecret) {
        throw new Error('Server configuration error: TELEGRAM credentials missing in Supabase secrets');
      }

      const tokenRes = await fetch(TELEGRAM_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code: body.code,
          redirect_uri: redirectUri,
          ...(body.code_verifier ? { code_verifier: body.code_verifier } : {}),
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Token exchange failed: ${err}`);
      }

      const tokenData = await tokenRes.json();
      const payload = await verifyTelegramJWT(tokenData.id_token);
      telegramId = payload.sub ?? payload.id;

    } else if (body.id_token) {
      const payload = await verifyTelegramJWT(body.id_token);
      telegramId = payload.sub ?? payload.id;

    } else if (body.telegramPayload) {
      if (!botToken) {
        throw new Error('Server configuration error: TELEGRAM_BOT_TOKEN missing in Supabase secrets');
      }

      const isValid = await verifyTelegramHMAC(body.telegramPayload, botToken);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Invalid Telegram Signature' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      telegramId = body.telegramPayload.id;
    } else {
      throw new Error('Invalid request payload');
    }

    if (!telegramId) throw new Error('Could not extract Telegram user ID');

    const strTelegramId = String(telegramId);
    const isSuperAdminAllowlisted = superAdminIds.includes(strTelegramId);

    // Query user in database
    let userRecord: { id?: string; email?: string; role?: string; full_name?: string } | null = null;

    const { data: tgUsers } = await supabaseAdmin
      .from('telegram_users')
      .select('id, email, role, display_name')
      .eq('telegram_user_id', strTelegramId)
      .limit(1);

    if (tgUsers && tgUsers.length > 0) {
      userRecord = {
        id: tgUsers[0].id,
        email: tgUsers[0].email,
        role: tgUsers[0].role,
        full_name: tgUsers[0].display_name
      };
    }

    if (!userRecord && !isSuperAdminAllowlisted) {
      return new Response(JSON.stringify({ 
        error: `Telegram ID (${telegramId}) belum terdaftar di database Backoffice. Hubungi Super Admin untuk mendaftarkan akun Anda.` 
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const email = userRecord?.email || (isSuperAdminAllowlisted ? 'abiediendomba64@gmail.com' : null);
    if (!email) {
      return new Response(JSON.stringify({ error: 'Akun tidak memiliki email valid yang terdaftar.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const effectiveRole = isSuperAdminAllowlisted ? 'super_admin' : (userRecord?.role || 'operator');

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: {
        data: {
          telegram_id: strTelegramId,
          role: effectiveRole,
          dashboard_access: true,
        }
      }
    });

    if (linkError) throw linkError;

    return new Response(JSON.stringify({
      success: true,
      email,
      magic_link: linkData.properties.action_link,
      user: {
        telegram_id: strTelegramId,
        email,
        role: effectiveRole,
        full_name: userRecord?.full_name || 'Abied Iendomba',
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
