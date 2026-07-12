const mysql = require('mysql2/promise');

async function syncXp() {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'Kenan123..',
    database: 'parlabridge'
  });

  try {
    const [users] = await pool.query('SELECT user_id, user_total_xp FROM users');
    
    console.log(`Bulunan kullanıcı sayısı: ${users.length}`);

    let updatedCount = 0;

    for (const user of users) {
      let level = 1;
      let remainingXp = user.user_total_xp || 0;

      while (true) {
        // Seviye atlamak için gereken XP: 100 * (1.5 ^ (level - 1))
        let req = Math.floor(100 * Math.pow(1.5, level - 1));
        
        if (remainingXp >= req) {
          remainingXp -= req;
          level++;
        } else {
          break;
        }
      }

      await pool.query('UPDATE users SET user_level = ?, user_level_xp = ? WHERE user_id = ?', [level, remainingXp, user.user_id]);
      updatedCount++;
      console.log(`Kullanıcı: ${user.user_id} -> Seviye: ${level}, XP: ${remainingXp} (Toplam: ${user.user_total_xp})`);
    }

    console.log(`✅ Toplam ${updatedCount} kullanıcı başarıyla 1.5x formülüne göre güncellendi.`);
  } catch (error) {
    console.error("Veritabanı hatası:", error);
  } finally {
    await pool.end();
  }
}

syncXp();
