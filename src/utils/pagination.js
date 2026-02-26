function paginate(query, { page = 1, limit = 20, maxLimit = 100 } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { query: query.skip(skip).limit(limit), page, limit, skip };
}

function paginationMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    hasPrevPage: page > 1,
  };
}

module.exports = { paginate, paginationMeta };
