module.exports = {
  success: (data, message = 'Success') => ({ success: true, message, data }),
  error: (message = 'Error', errors = null) => ({ success: false, message, errors }),
  paginated: (data, pagination) => ({ success: true, data, pagination }),
};
