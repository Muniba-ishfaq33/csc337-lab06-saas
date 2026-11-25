// lets us write async route handlers without try/catch everywhere
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { wrap };
