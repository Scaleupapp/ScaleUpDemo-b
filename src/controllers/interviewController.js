const interviewService = require('../services/interviewService');
const apiResponse = require('../utils/apiResponse');

const startInterview = async (req, res, next) => {
  try {
    const { interviewType, targetRole, targetCompany, difficulty } = req.body;
    if (!interviewType) return res.status(400).json(apiResponse.error('interviewType is required'));

    const validTypes = ['mba_admissions', 'placement_hr', 'placement_technical', 'case_study', 'behavioral'];
    if (!validTypes.includes(interviewType)) {
      return res.status(400).json(apiResponse.error(`interviewType must be one of: ${validTypes.join(', ')}`));
    }

    const { objectiveId } = req.body;
    const data = await interviewService.startInterview(req.user.userId, {
      interviewType, targetRole, targetCompany, difficulty, objectiveId,
    });
    res.status(201).json(apiResponse.success(data, 'Interview started'));
  } catch (err) { next(err); }
};

const completeInterview = async (req, res, next) => {
  try {
    const { transcript, integrityData } = req.body;
    if (!transcript || !Array.isArray(transcript)) {
      return res.status(400).json(apiResponse.error('transcript array is required'));
    }

    const data = await interviewService.saveTranscript(req.user.userId, req.params.id, {
      transcript, integrityData,
    });
    res.json(apiResponse.success(data, 'Interview completed, evaluation queued'));
  } catch (err) { next(err); }
};

const uploadSnapshot = async (req, res, next) => {
  try {
    let imageBuffer;

    if (req.file) {
      // multer upload
      imageBuffer = req.file.buffer;
    } else if (req.body.image) {
      // base64 in JSON body
      const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    } else {
      return res.status(400).json(apiResponse.error('Image is required (file upload or base64 "image" field)'));
    }

    const data = await interviewService.uploadSnapshot(req.user.userId, req.params.id, imageBuffer);
    res.json(apiResponse.success(data, 'Snapshot uploaded'));
  } catch (err) { next(err); }
};

const getSession = async (req, res, next) => {
  try {
    const data = await interviewService.getSession(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const getStatus = async (req, res, next) => {
  try {
    const data = await interviewService.getStatus(req.user.userId, req.params.id);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const listSessions = async (req, res, next) => {
  try {
    const data = await interviewService.listSessions(req.user.userId, req.query);
    res.json(apiResponse.success(data));
  } catch (err) { next(err); }
};

const deleteSession = async (req, res, next) => {
  try {
    const data = await interviewService.deleteSession(req.user.userId, req.params.id);
    res.json(apiResponse.success(data, 'Interview session deleted'));
  } catch (err) { next(err); }
};

const getUploadURL = async (req, res, next) => {
  try {
    const data = await interviewService.getUploadURL(req.user.userId, req.params.id);
    res.json(apiResponse.success(data, 'Upload URL generated'));
  } catch (err) { next(err); }
};

const processVoiceAnswer = async (req, res, next) => {
  try {
    const { audioKey } = req.body;
    if (!audioKey) return res.status(400).json(apiResponse.error('audioKey is required'));

    const data = await interviewService.processVoiceAnswer(req.user.userId, req.params.id, audioKey);
    res.json(apiResponse.success(data, 'Voice answer processed'));
  } catch (err) { next(err); }
};

const getRealtimeToken = async (req, res, next) => {
  try {
    const data = await interviewService.getRealtimeToken(req.user.userId, req.params.id);
    res.json(apiResponse.success(data, 'Realtime token generated'));
  } catch (err) { next(err); }
};

module.exports = {
  startInterview,
  completeInterview,
  uploadSnapshot,
  getSession,
  getStatus,
  listSessions,
  deleteSession,
  getUploadURL,
  processVoiceAnswer,
  getRealtimeToken,
};
