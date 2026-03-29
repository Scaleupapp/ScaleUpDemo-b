const authService = require('../services/authService');
const apiResponse = require('../utils/apiResponse');

const register = async (req, res, next) => {
  try {
    const data = await authService.register(req.body);
    res.status(201).json(apiResponse.success(data, 'Registration successful'));
  } catch (err) { next(err); }
};

const login = async (req, res, next) => {
  try {
    const data = await authService.login(req.body);
    res.json(apiResponse.success(data, 'Login successful'));
  } catch (err) { next(err); }
};

const googleLogin = async (req, res, next) => {
  try {
    const data = await authService.googleLogin(req.body);
    res.json(apiResponse.success(data, 'Google login successful'));
  } catch (err) { next(err); }
};

const refreshToken = async (req, res, next) => {
  try {
    const data = await authService.refreshToken(req.body.refreshToken);
    res.json(apiResponse.success(data, 'Token refreshed'));
  } catch (err) { next(err); }
};

const forgotPassword = async (req, res, next) => {
  try {
    const data = await authService.forgotPassword(req.body.email);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const resetPassword = async (req, res, next) => {
  try {
    const data = await authService.resetPassword(req.body);
    res.json(apiResponse.success(data, 'Password reset successful'));
  } catch (err) { next(err); }
};

const sendPhoneOTP = async (req, res, next) => {
  try {
    const data = await authService.sendPhoneOTP(req.body.phone);
    res.json(apiResponse.success(data, 'OTP sent'));
  } catch (err) { next(err); }
};

const verifyPhoneOTP = async (req, res, next) => {
  try {
    const data = await authService.verifyPhoneOTP(req.body);
    const message = data.isNewUser ? 'Account created and logged in' : 'Login successful';
    res.json(apiResponse.success(data, message));
  } catch (err) { next(err); }
};

const verifyPhone = async (req, res, next) => {
  try {
    const data = await authService.verifyPhoneForUser(req.user.userId, req.body);
    res.json(apiResponse.success(data, 'Phone verified'));
  } catch (err) { next(err); }
};

const logout = async (req, res, next) => {
  try {
    const data = await authService.logout(req.user.userId);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const reactivate = async (req, res, next) => {
  try {
    const data = await authService.reactivate(req.body);
    res.json(apiResponse.success(data, 'Account reactivated'));
  } catch (err) { next(err); }
};

module.exports = {
  register, login, googleLogin, refreshToken, forgotPassword, resetPassword,
  sendPhoneOTP, verifyPhoneOTP, verifyPhone, logout, reactivate,
};
