const College = require('../models/College');
const apiResponse = require('../utils/apiResponse');

const searchColleges = async (req, res, next) => {
  try {
    const { q, limit = 15 } = req.query;
    if (!q || q.length < 2) {
      return res.json(apiResponse.success([]));
    }

    const searchTerm = q.toLowerCase().trim();
    const limitNum = Math.min(parseInt(limit) || 15, 50);

    // Regex search on normalized name (works for partial matches like "iim" or "iit b")
    const results = await College.find({
      nameNormalized: { $regex: searchTerm, $options: 'i' }
    })
      .select('name fullName district state type')
      .limit(limitNum)
      .lean();

    // Sort: exact prefix matches first, then contains
    results.sort((a, b) => {
      const aStarts = a.nameNormalized?.startsWith(searchTerm) ? 0 : 1;
      const bStarts = b.nameNormalized?.startsWith(searchTerm) ? 0 : 1;
      return aStarts - bStarts;
    });

    res.json(apiResponse.success(results));
  } catch (err) {
    next(err);
  }
};

module.exports = { searchColleges };
