// CommonJS repo. Exercises module.exports.X = function() pattern.
const { db } = require('./client');

module.exports.findUserByEmail = async function findUserByEmail(email) {
  const r = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return r.rows[0];
};

module.exports.findOrCreateUser = async function findOrCreateUser(email, name) {
  const found = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
  if (found.rows[0]) return found.rows[0];
  const created = await db.query(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *`,
    [email, name]
  );
  return created.rows[0];
};

module.exports.findAll = async function findAll() {
  const r = await db.query(`SELECT * FROM users`);
  return r.rows;
};

module.exports.upsert = async function upsert(user) {
  return db.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
    [user.id, user.email, user.name]
  );
};
