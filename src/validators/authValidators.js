const Joi = require('joi');

const register = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(128).required(),
  firstName: Joi.string().trim().min(1).max(50).required(),
  lastName: Joi.string().trim().max(50).allow('').optional(),
});

const login = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const forgotPassword = Joi.object({
  email: Joi.string().email().required(),
});

const resetPassword = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
  newPassword: Joi.string().min(8).max(128).required(),
});

const sendPhoneOTP = Joi.object({
  phone: Joi.string().min(10).max(15).required(),
});

const verifyPhoneOTP = Joi.object({
  phone: Joi.string().min(10).max(15).required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
  firstName: Joi.string().trim().min(1).max(50).optional(),
  lastName: Joi.string().trim().max(50).allow('').optional(),
});

const verifyPhone = Joi.object({
  phone: Joi.string().min(10).max(15).required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
});

module.exports = { register, login, forgotPassword, resetPassword, sendPhoneOTP, verifyPhoneOTP, verifyPhone };
