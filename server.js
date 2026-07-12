const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger').createLogger(); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// MySQL Bağlantı Havuzu
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'Kenan123..', // Kendi veritabanı şifrenizle değiştirin
  database: 'parlabridge'
});

// Middleware
const cors = require('cors');
app.use(cors());
app.use(express.json());

// ==========================================
// GOOGLE İLE GİRİŞ (REST API)
// ==========================================
app.post('/auth/google', async (req, res) => {
  const { email, displayName, googleId, nativeLanguage, targetLanguage } = req.body;
  if (!email || !googleId) {
    return res.status(400).json({ error: 'Email ve googleId gerekli' });
  }

  const userNative = nativeLanguage || null;
  const userTarget = targetLanguage || null;

  try {
    // 1. Kullanıcı daha önce kayıtlı mı? (eski kullanıcılar googleId ile, yeniler email ile bulunabilir)
    const [rows] = await pool.query('SELECT user_id, user_native_language, user_target_language FROM users WHERE user_id = ? OR email = ?', [googleId, email]);
    
    if (rows.length > 0) {
      // Eski kullanıcı, mevcut user_id'yi dön
      return res.json({ 
        user_id: rows[0].user_id,
        native_language: rows[0].user_native_language,
        target_language: rows[0].user_target_language
      });
    } else {
      // 2. Yeni kullanıcı, kendi standart formatımızda UID oluştur (28 karakterlik)
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let customUserId = '';
      for (let i = 0; i < 28; i++) {
        customUserId += chars.charAt(Math.floor(Math.random() * chars.length));
      }

      const query = `
        INSERT INTO users (user_id, user_name, email, auth_provider, user_native_language, user_target_language, user_target_language_level)
        VALUES (?, ?, ?, 'google', ?, ?, 'A1')
      `;
      await pool.query(query, [customUserId, displayName || 'Kullanıcı', email, userNative, userTarget]);
      
      return res.json({ user_id: customUserId });
    }
  } catch (error) {
    console.error('Google Auth Hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası', details: error.toString() });
  }
});

// ==========================================
// E-POSTA VE ŞİFRE İLE GİRİŞ (REST API)
// ==========================================
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email ve şifre gerekli' });
  }

  try {
    const [rows] = await pool.query('SELECT user_id, password_hash, user_native_language, user_target_language FROM users WHERE email = ? AND auth_provider = "email"', [email]);
    
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Bu e-posta adresi ile kayıtlı kullanıcı bulunamadı.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ error: 'Hatalı şifre.' });
    }
    
    return res.json({ 
      user_id: user.user_id,
      native_language: user.user_native_language,
      target_language: user.user_target_language
    });
  } catch (error) {
    console.error('Login Hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası', details: error.toString() });
  }
});

// ==========================================
// E-POSTA VE ŞİFRE İLE KAYIT (REST API)
// ==========================================
app.post('/auth/register', async (req, res) => {
  const { email, password, displayName, referralCode, nativeLanguage, targetLanguage } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email ve şifre gerekli' });
  }

  const userNative = nativeLanguage || null;
  const userTarget = targetLanguage || null;
  logger.error(`Yeni kayıt isteği alındı: email=${email}, native=${userNative}, target=${userTarget}`);

  try {
    // 1. Kullanıcı daha önce kayıtlı mı?
    const [rows] = await pool.query('SELECT user_id FROM users WHERE email = ?', [email]);
    
    if (rows.length > 0) {
      return res.status(409).json({ error: 'Bu email adresi zaten kullanılıyor.' });
    }

    // 2. Şifreyi hashle
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // 3. Benzersiz UID oluştur (Firebase tarzı 28 karakterlik)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let userId = '';
    for (let i = 0; i < 28; i++) {
      userId += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // 4. Yeni kullanıcı, tabloya ekle
    const query = `
      INSERT INTO users (user_id, user_name, email, password_hash, auth_provider, user_native_language, user_target_language, user_target_language_level)
      VALUES (?, ?, ?, ?, 'email', ?, ?, 'A1')
    `;
    await pool.query(query, [userId, displayName || 'Kullanıcı', email, passwordHash, userNative, userTarget]);
    
    // 5. Davet Kodu (Referral) Kontrolü ve Ödül Dağıtımı
    if (referralCode && referralCode.trim().length >= 12) {
      const code = referralCode.trim().substring(0, 12);
      const [inviterRows] = await pool.query("SELECT user_id FROM users WHERE user_id LIKE CONCAT(?, '%') LIMIT 1", [code]);
      if (inviterRows.length > 0) {
        const inviterId = inviterRows[0].user_id;
        
        // A) Davet edene (eski kullanıcıya) 500 Elmas ve 3 Günlük Premium ver
        await pool.query(`
          UPDATE users 
          SET users_diamonds = users_diamonds + 500, 
              is_user_premium_subscripted = 1,
              premium_expiration_date = DATE_ADD(NOW(), INTERVAL 3 DAY),
              premium_start_date = IFNULL(premium_start_date, NOW())
          WHERE user_id = ?
        `, [inviterId]);
        
        // B) Davetle gelene (yeni üyeye) sadece 500 Elmas başlangıç ödülü ver
        await pool.query(`
          UPDATE users 
          SET users_diamonds = users_diamonds + 500 
          WHERE user_id = ?
        `, [userId]);

        // C) İstatistik ve takip için referrals tablosuna kaydet
        await pool.query(`
          INSERT INTO user_referrals (inviter_id, invitee_id, used_code) 
          VALUES (?, ?, ?)
        `, [inviterId, userId, code]);
        
        console.log(`[REFERRAL_SUCCESS] Davet Eden (${inviterId}) -> 3 Gün Premium & 500 Elmas Kazandı.`);
        console.log(`[REFERRAL_SUCCESS] Yeni Üye (${userId}) -> 500 Elmas Hoş Geldin Ödülü Kazandı.`);
      }
    }

    return res.status(201).json({ user_id: userId });
  } catch (error) {
    console.error('Register Hatası:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ==========================================
// YARDIMCI FONKSİYONLAR (Veri Çekip İstemciye Yollamak İçin)
// ==========================================
async function fetchAndEmitUserData(userId, socket) {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE user_id = ?', [userId]);
    if (rows.length > 0) {
      let user = rows[0];
      // Premium süresi dolmuşsa iptal et
      if (user.is_user_premium_subscripted === 1 && user.premium_expiration_date) {
        const now = new Date();
        const expirationDate = new Date(user.premium_expiration_date);
        if (expirationDate < now) {
          await pool.query('UPDATE users SET is_user_premium_subscripted = 0, is_auto_renewing = 0, premium_subscription_plan = "none" WHERE user_id = ?', [userId]);
          user.is_user_premium_subscripted = 0;
          user.is_auto_renewing = 0;
          user.premium_subscription_plan = "none";
          console.log(`[PREMIUM_EXPIRED] User ${userId} premium status revoked due to expiration.`);
        }
      }
      socket.emit('user_data_updated', user);
    }
  } catch (error) { console.error('user fetch error', error); }
}

async function fetchAndEmitInventory(userId, socket) {
  try {
    const [rows] = await pool.query('SELECT * FROM user_inventory WHERE user_id = ?', [userId]);
    if (rows.length > 0) socket.emit('inventory_updated', rows[0]);
  } catch (error) { console.error('inventory fetch error', error); }
}

async function fetchAndEmitQuests(userId, socket) {
  try {
    const [rows] = await pool.query('SELECT * FROM user_daily_quests WHERE user_id = ? AND quest_date = CURDATE()', [userId]);
    socket.emit('quests_updated', rows);
  } catch (error) { console.error('quests fetch error', error); }
}

async function fetchAndEmitAchievements(userId, socket) {
  try {
    const [rows] = await pool.query('SELECT * FROM user_achievements WHERE user_id = ?', [userId]);
    socket.emit('achievements_updated', rows);
  } catch (error) { console.error('achievements fetch error', error); }
}

async function fetchAndEmitWeeklyStreak(userId, socket) {
  try {
    const todayStr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];

    const [rows] = await pool.query(`
      SELECT mon, tue, wed, thu, fri, sat, sun, 
             YEARWEEK(last_update_date, 1) AS last_week, 
             YEARWEEK(CURDATE(), 1) AS current_week 
      FROM user_weekly_streak 
      WHERE user_id = ?
    `, [userId]);

    let row;
    if (rows.length === 0) {
      await pool.query(`
        INSERT INTO user_weekly_streak (user_id, ${todayStr}, last_update_date)
        VALUES (?, 1, CURDATE())
      `, [userId]);
      row = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
      row[todayStr] = 1;
    } else {
      row = rows[0];
      if (row.last_week !== row.current_week) {
        await pool.query(`
          UPDATE user_weekly_streak 
          SET mon=0, tue=0, wed=0, thu=0, fri=0, sat=0, sun=0, ${todayStr}=1, last_update_date=CURDATE()
          WHERE user_id = ?
        `, [userId]);
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].forEach(d => row[d] = 0);
        row[todayStr] = 1;
      } else {
        if (row[todayStr] !== 1) {
          await pool.query(`
            UPDATE user_weekly_streak 
            SET ${todayStr}=1, last_update_date=CURDATE()
            WHERE user_id = ?
          `, [userId]);
          row[todayStr] = 1;
        }
      }
    }

    const streakArray = [row.mon, row.tue, row.wed, row.thu, row.fri, row.sat, row.sun];
    socket.emit('weekly_streak_data', streakArray);
    
  } catch (error) {
    console.error('fetchAndEmitWeeklyStreak error:', error);
  }
}

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId;
  console.log(`Bir kullanıcı bağlandı: Socket=${socket.id}, UserID=${userId}`);

  if (userId) {
    // 1. BAĞLANIR BAĞLANMAZ TÜM GÜNCEL VERİLERİ İSTEMCİYE FIRLAT
    fetchAndEmitUserData(userId, socket);
    fetchAndEmitInventory(userId, socket);
    fetchAndEmitQuests(userId, socket);
    fetchAndEmitAchievements(userId, socket);
    fetchAndEmitLeaderboard(userId, socket);
    fetchAndEmitWeakWords(userId, socket);
    fetchAndEmitDailyActivity(userId, socket);
    fetchAndEmitWeeklyStreak(userId, socket);
  }

  // ==========================================
  // 2. KULLANICI ALANINI GÜNCELLE (XP, Elmas, Seri, Ayarlar)
  // ==========================================
  socket.on('update_user_field', async (data) => {
    try {
      const { field, value } = data;
      console.log(`[SOCKET] update_user_field isteği alındı: field=${field}, value=${value}, userId=${userId}`);
      
      // Sadece güvenli (izin verilen) sütunların güncellenmesine izin ver
      const allowedFields = [
        'sound_effects_enabled', 'user_total_xp', 'users_diamonds', 
        'current_streak', 'longest_streak', 'user_target_language_level',
        'user_target_language', 'user_native_language', 'is_user_premium_subscripted', 'premium_expiration_date', 'premium_start_date', 'last_activity_date',
        'user_level', 'user_level_xp', 'premium_subscription_plan', 'is_auto_renewing'
      ];

      if (allowedFields.includes(field) && userId) {
        console.log(`[SOCKET] Veritabanı güncelleniyor: ${field} = ${value}`);
        const [result] = await pool.query(`UPDATE users SET ?? = ? WHERE user_id = ?`, [field, value, userId]);
        console.log(`[SOCKET] Güncelleme sonucu: affectedRows=${result.affectedRows}`);
        
        if (field === 'premium_expiration_date' && value !== null) {
          console.log(`[PREMIUM_CHEST_SUCCESS] Kullanıcı (${userId}) -> 1 Günlük Premium Süresi DB'ye İşlendi. Bitiş: ${value}`);
        }
        
        await fetchAndEmitUserData(userId, socket); // Güncel halini geri yolla
        
        if (field === 'user_total_xp' || field === 'current_league') {
          fetchAndEmitLeaderboard(userId, socket);
        }
      } else {
        console.warn(`[SOCKET] Güncelleme reddedildi! İzin verilmeyen field: ${field} veya userId yok.`);
      }
    } catch (error) { console.error('update_user_field error:', error); }
  });

  // ==========================================
  // LİDERLİK TABLOSU GETİR (Göreceli Liderlik)
  // ==========================================
  socket.on('request_leaderboard', async () => {
    if (!userId) return;
    try {
      const rankQuery = `
        WITH RankedUsers AS (
          SELECT 
            user_id, 
            user_name, 
            user_total_xp AS weekly_xp, 
            current_league,
            RANK() OVER (PARTITION BY current_league ORDER BY user_total_xp DESC) as \`rank\`
          FROM users
        )
        SELECT * FROM RankedUsers
      `;
      const [rankedRows] = await pool.query(rankQuery);

      const currentUserData = rankedRows.find(u => u.user_id === userId);
      const userRank = currentUserData ? currentUserData.rank : null;
      const userLeague = currentUserData ? currentUserData.current_league : null;

      const finalUsersMap = new Map();
      
      for (const row of rankedRows) {
        // Her ligin ilk 10'unu al
        if (row.rank <= 10) {
          finalUsersMap.set(row.user_id, row);
        }
        // Mevcut kullanıcının kendi ligindeki çevresini al (Rank -1, Rank, Rank +1)
        if (userRank && userLeague && row.current_league === userLeague) {
          if (row.rank >= userRank - 1 && row.rank <= userRank + 1) {
            finalUsersMap.set(row.user_id, row);
          }
        }
      }

      const finalUsersArray = Array.from(finalUsersMap.values()).sort((a, b) => a.rank - b.rank);
      socket.emit('league_data_updated', finalUsersArray);
    } catch (error) {
      console.error('request_leaderboard error:', error);
    }
  });

  // ==========================================
  // 3. KELİME ÖĞRENİLDİ & PRATİK EDİLDİ
  // ==========================================
socket.on('word_learned', async (data) => {
  try {
    console.log('[word_learned] Gelen veri:', data);
    const { word_id, word, meaning, language } = data;
    if (!userId || !word) {
      console.warn('[word_learned] userId veya word eksik');
      return;
    }

    const query = `
      INSERT INTO user_learned_words (user_id, word_id, word, word_meaning, mastery_level, times_practiced)
      VALUES (?, ?, ?, ?, 2, 1)
      ON DUPLICATE KEY UPDATE 
        word = VALUES(word),
        word_meaning = VALUES(word_meaning),
        word_id = VALUES(word_id),   -- ✅ her zaman güncelle
        mastery_level = GREATEST(mastery_level, 2),
        times_practiced = COALESCE(times_practiced, 0) + 1,
        times_failed = GREATEST(0, COALESCE(times_failed, 0) - 1),
        last_reviewed_at = CURRENT_TIMESTAMP;
    `;
    const [result] = await pool.query(query, [userId, word_id || null, word, meaning || null]);
    fetchAndEmitWeakWords(userId, socket);
    console.log('[word_learned] Sorgu sonucu:', result);
  } catch (error) {
    console.error('[word_learned] Hata:', error);
  }
});

socket.on('word_practiced', async (data) => {
  try {
    const { word_id, word, meaning, language } = data;
    if (!userId || !word) return;

    const query = `
      INSERT INTO user_learned_words (user_id, word_id, word, word_meaning, mastery_level, times_practiced)
      VALUES (?, ?, ?, ?, 1, 1)
      ON DUPLICATE KEY UPDATE 
        word = VALUES(word),
        word_meaning = VALUES(word_meaning),
        word_id = COALESCE(word_id, VALUES(word_id)),   -- ✅ NULL ise güncelle
        times_practiced = COALESCE(times_practiced, 0) + 1,
        times_failed = GREATEST(0, COALESCE(times_failed, 0) - 1),
        last_reviewed_at = CURRENT_TIMESTAMP;
    `;
    await pool.query(query, [userId, word_id || null, word, meaning || null]);
    fetchAndEmitWeakWords(userId, socket);
  } catch (error) {
    console.error('[word_practiced] Hata:', error);
  }
});

 socket.on('word_failed', async (data) => {
  try {
    const { word_id, word, meaning, language } = data;
    if (!userId || !word) return;

    const query = `
      INSERT INTO user_learned_words (user_id, word_id, word, word_meaning, mastery_level, times_failed)
      VALUES (?, ?, ?, ?, 0, 1)
      ON DUPLICATE KEY UPDATE 
        word = VALUES(word),
        word_meaning = VALUES(word_meaning),
        word_id = COALESCE(word_id, VALUES(word_id)),   -- ✅ NULL ise güncelle
        times_failed = COALESCE(times_failed, 0) + 1,
        last_reviewed_at = CURRENT_TIMESTAMP;
    `;
    await pool.query(query, [userId, word_id || null, word, meaning || null]);
    fetchAndEmitWeakWords(userId, socket);
  } catch (error) {
    console.error('[word_failed] Hata:', error);
  }
});

  // ==========================================
  // 4. MAĞAZA SATIN ALIMLARI (Shop & Inventory)
  // ==========================================
  socket.on('purchase_item', async (data) => {
    try {
      const { itemName, costDiamonds } = data;
      if (!userId) return;

      // Satın alım işlemlerinde veri güvenliği için Transaction başlat
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // Mevcut elmas miktarını çek (FOR UPDATE ile kilit koy)
        const [users] = await connection.query('SELECT users_diamonds FROM users WHERE user_id = ? FOR UPDATE', [userId]);
        if (users.length === 0 || users[0].users_diamonds < costDiamonds) {
          throw new Error('Yetersiz bakiye veya kullanıcı bulunamadı');
        }

        // 1. Elmasları düşür
        await connection.query('UPDATE users SET users_diamonds = users_diamonds - ? WHERE user_id = ?', [costDiamonds, userId]);

        // 2. Transaction (Satın Alım) Logunu ekle
        await connection.query(
          'INSERT INTO shop_transactions (user_id, item_name, cost_diamonds) VALUES (?, ?, ?)',
          [userId, itemName, costDiamonds]
        );

        // 3. Eşyayı envantere ekle
        if (itemName === 'streak_freeze') {
           await connection.query(`
            INSERT INTO user_inventory (user_id, streak_freezes) VALUES (?, 1)
            ON DUPLICATE KEY UPDATE streak_freezes = streak_freezes + 1
           `, [userId]);
        } else if (itemName === 'hint_card') {
           await connection.query(`
            INSERT INTO user_inventory (user_id, hints_available) VALUES (?, 1)
            ON DUPLICATE KEY UPDATE hints_available = hints_available + 1
           `, [userId]);
        }

        // Başarılıysa onayla
        await connection.commit();
        connection.release();

        // 4. Güncel verileri istemciye gönder (UI tazelensin)
        await fetchAndEmitUserData(userId, socket);
        await fetchAndEmitInventory(userId, socket);

      } catch (err) {
        // Hata çıkarsa işlemi geri al
        await connection.rollback();
        connection.release();
        console.error('Satın alım iptal edildi:', err.message);
      }
    } catch (error) { console.error('purchase_item error:', error); }
  });

  // ==========================================
  // 5. GÜNLÜK GÖREV İLERLEMESİ (Quests)
  // ==========================================
  socket.on('update_quest_progress', async (data) => {
    try {
      const { questType, addedProgress } = data;
      if (!userId) return;
      
      let targetValue = data.target || 20; // Default (kelime çalışması)
      if (!data.target && (questType === 'mini_games_played' || questType === 'Egzersiz Pratiği')) {
         targetValue = 2; // Egzersiz hedefi
      }
      
      const query = `
        INSERT INTO user_daily_quests (user_id, quest_date, quest_type, progress, target, is_claimed)
        VALUES (?, CURDATE(), ?, ?, ?, 0)
        ON DUPLICATE KEY UPDATE 
        target = ?,
        progress = LEAST(progress + ?, target)
      `;
      await pool.query(query, [userId, questType, addedProgress, targetValue, targetValue, addedProgress]);
      
      await fetchAndEmitQuests(userId, socket);
    } catch (error) { console.error('update_quest_progress error:', error); }
  });

  // ==========================================
  // 6. BAŞARIM KAZANILMASI (Achievements)
  // ==========================================
  socket.on('unlock_achievement', async (data) => {
    try {
      const { achievementKey } = data;
      if (!userId) return;

      const query = `
        INSERT IGNORE INTO user_achievements (user_id, achievement_key)
        VALUES (?, ?)
      `;
      await pool.query(query, [userId, achievementKey]);
      
      await fetchAndEmitAchievements(userId, socket);
    } catch (error) { console.error('unlock_achievement error:', error); }
  });

  // ==========================================
  // 7. OYUN BİTİŞİ & SKOR KAYDI (Game Finished)
  // ==========================================
  socket.on('game_finished', async (data) => {
    try {
      const { gameName, score, maxCombo } = data;
      if (!userId) return;

      // Oyun skorunu kaydet (Daha iyisi yapıldıysa best_score'u güncelle)
      const query = `
        INSERT INTO user_games_scores (user_id, game_name, best_score, max_combo, total_played)
        VALUES (?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE 
        best_score = GREATEST(best_score, ?),
        max_combo = GREATEST(max_combo, ?),
        total_played = total_played + 1;
      `;
      await pool.query(query, [userId, gameName, score, maxCombo, score, maxCombo]);

    } catch (error) { console.error('game_finished error:', error); }
  });

  socket.on('add_daily_xp', async (data) => {
    try {
      if (!userId || !data.amount) return;
      const query = `
        INSERT INTO user_daily_activity (user_id, activity_date, xp_earned) 
        VALUES (?, CURRENT_DATE(), ?) 
        ON DUPLICATE KEY UPDATE xp_earned = xp_earned + ?
      `;
      await pool.query(query, [userId, data.amount, data.amount]);
      fetchAndEmitDailyActivity(userId, socket);
    } catch (error) { console.error('add_daily_xp error:', error); }
  });

  socket.on('request_all_data', () => {
    if (userId) {
      fetchAndEmitUserData(userId, socket);
      fetchAndEmitInventory(userId, socket);
      fetchAndEmitQuests(userId, socket);
      fetchAndEmitAchievements(userId, socket);
      fetchAndEmitLeaderboard(userId, socket);
      fetchAndEmitWeakWords(userId, socket);
      fetchAndEmitDailyActivity(userId, socket);
    }
  });

  socket.on('request_weak_words', () => {
    if (userId) {
      fetchAndEmitWeakWords(userId, socket);
    }
  });

  socket.on('disconnect', () => {
    console.log('Kullanıcı ayrıldı:', socket.id);
  });
});

async function fetchAndEmitWeakWords(userId, socket) {
  try {
    const query = `
      SELECT word_id, word, word_meaning, times_failed 
      FROM user_learned_words 
      WHERE user_id = ? AND times_failed > 0 
      ORDER BY times_failed DESC 
      LIMIT 20
    `;
    const [rows] = await pool.query(query, [userId]);
    socket.emit('weak_words_updated', rows);
  } catch (error) {
    console.error('fetchAndEmitWeakWords error:', error);
  }
}

async function fetchAndEmitLeaderboard(userId, socket) {
  try {
    const rankQuery = `
      WITH RankedUsers AS (
        SELECT 
          user_id, 
          user_name, 
          user_total_xp AS weekly_xp, 
          current_league,
          RANK() OVER (PARTITION BY current_league ORDER BY user_total_xp DESC) as \`rank\`
        FROM users
      )
      SELECT * FROM RankedUsers
    `;
    const [rankedRows] = await pool.query(rankQuery);

    const currentUserData = rankedRows.find(u => u.user_id === userId);
    const userRank = currentUserData ? currentUserData.rank : null;
    const userLeague = currentUserData ? currentUserData.current_league : null;

    const finalUsersMap = new Map();
    
    for (const row of rankedRows) {
      if (row.rank <= 10) {
        finalUsersMap.set(row.user_id, row);
      }
      if (userRank && userLeague && row.current_league === userLeague) {
        if (row.rank >= userRank - 1 && row.rank <= userRank + 1) {
          finalUsersMap.set(row.user_id, row);
        }
      }
    }

    const finalUsersArray = Array.from(finalUsersMap.values()).sort((a, b) => a.rank - b.rank).map(u => ({
      ...u,
      isCurrentUser: u.user_id === userId
    }));

    socket.emit('league_data_updated', finalUsersArray);
  } catch (error) {
    console.error('fetchAndEmitLeaderboard error:', error);
  }
}

async function fetchAndEmitDailyActivity(userId, socket) {
  try {
    const query = `
      SELECT DATE_FORMAT(activity_date, '%Y-%m-%d') as date, xp_earned 
      FROM user_daily_activity 
      WHERE user_id = ? AND activity_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 DAY)
      ORDER BY activity_date ASC
    `;
    const [rows] = await pool.query(query, [userId]);
    socket.emit('daily_activity_updated', rows);
  } catch (error) {
    console.error('fetchAndEmitDailyActivity error:', error);
  }
}


server.listen(3000, () => {
  console.log('Sunucu 3000 portunda çalışıyor');
});