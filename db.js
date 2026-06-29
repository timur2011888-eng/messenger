const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL; 

if (!connectionString) {
  console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Переменная DATABASE_URL не задана в настройках Render!");
}

const client = new Client({
  connectionString: connectionString,
  // Принудительно заставляем использовать IPv4 (семейство адресов 4)
  connection: {
    family: 4
  },
  ssl: { rejectUnauthorized: false }
});

client.connect()
  .then(() => console.log('🚀 Успешно подключено к базе данных Supabase Postgres через IPv4!'))
  .catch(err => console.error('❌ Ошибка подключения к Supabase Postgres:', err));

// Обертка-имитатор под better-sqlite3
const db = {
  prepare: (sql) => {
    let formattedSql = sql;
    let paramIndex = 1;
    while (formattedSql.includes('?')) {
      formattedSql = formattedSql.replace('?', `$${paramIndex}`);
      paramIndex++;
    }

    formattedSql = formattedSql.replace(/unixepoch\(\)/g, 'extract(epoch from now())::int');

    return {
      run: (...params) => {
        return client.query(formattedSql, params)
          .then(res => ({ changes: res.rowCount }))
          .catch(err => { console.error('Ошибка выполнения SQL .run():', err); throw err; });
      },
      get: (...params) => {
        return client.query(formattedSql, params)
          .then(res => res.rows[0] || null)
          .catch(err => { console.error('Ошибка выполнения SQL .get():', err); throw err; });
      },
      all: (...params) => {
        return client.query(formattedSql, params)
          .then(res => res.rows || [])
          .catch(err => { 
            console.error('Ошибка выполнения SQL .all():', err); 
            return []; 
          });
      }
    };
  },
  transaction: (fn) => {
    return async (...args) => {
      await client.query('BEGIN');
      try {
        const result = await fn(...args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    };
  },
  pragma: () => {},
  exec: (sql) => {
    return client.query(sql)
      .catch(err => console.error('Ошибка exec SQL:', err));
  }
};

module.exports = db;
