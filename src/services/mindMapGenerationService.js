const openai = require('../config/openai');
const Content = require('../models/Content');
const MindMap = require('../models/MindMap');
const ApiError = require('../utils/apiError');

const MINDMAP_PROMPT = `You are an expert at creating concept maps for studying. Generate a hierarchical mind map from the provided educational content.

RULES:
- Create a mind map with 10-20 nodes maximum.
- The root node (level 0) should be the main topic/title.
- Level 1 nodes are the key concepts or main sections.
- Level 2 nodes are sub-concepts, details, or examples under each level 1 node.
- Each node has: id (unique string like "n1", "n2"), label (short text), description (brief explanation), level (0/1/2), parentId (id of parent node, null for root), importance (1-5).
- Each edge has: from (source node id), to (target node id), label (relationship description), type ("parent-child", "related", or "prerequisite").
- Include parent-child edges for the hierarchy, and optionally "related" edges for cross-connections between concepts.
- Assign a color category to each node: "primary" for root, "blue" for level 1, "green"/"purple"/"orange"/"teal" for level 2 based on their parent.

Return valid JSON:
{
  "nodes": [
    { "id": "n1", "label": "...", "description": "...", "level": 0, "parentId": null, "importance": 5, "color": "primary" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "includes", "type": "parent-child" }
  ]
}`;

class MindMapGenerationService {

  async generate(userId, contentId) {
    const content = await Content.findById(contentId);
    if (!content) throw new ApiError(404, 'Content not found');

    // Check existing
    const existing = await MindMap.findOne({ userId, contentId, status: 'ready' });
    if (existing) return existing;

    const contentText = content.ocrText || content.transcript || content.description || '';
    if (contentText.length < 50) throw new ApiError(400, 'Content has insufficient text for mind map generation');

    const keyConcepts = content.aiData?.keyConcepts?.map(kc => `${kc.concept}: ${kc.description || ''}`).join('\n') || '';

    // Create placeholder
    const mindMap = await MindMap.create({
      userId,
      contentId,
      title: `Mind Map: ${content.title}`,
      nodes: [],
      edges: [],
      totalNodes: 0,
      status: 'generating',
    });

    try {
      const inputText = contentText.slice(0, 10000);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: MINDMAP_PROMPT },
          {
            role: 'user',
            content: `CONTENT TITLE: ${content.title}\nTOPIC: ${content.domain || 'General'}\n\nKEY CONCEPTS:\n${keyConcepts}\n\nFULL TEXT:\n${inputText}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const nodes = (parsed.nodes || []).map(n => ({
        id: n.id,
        label: n.label,
        description: n.description || undefined,
        level: typeof n.level === 'number' ? n.level : 0,
        parentId: n.parentId || undefined,
        importance: typeof n.importance === 'number' ? Math.min(5, Math.max(1, n.importance)) : 3,
        color: n.color || undefined,
      }));
      const edges = (parsed.edges || []).map(e => ({
        from: e.from,
        to: e.to,
        label: e.label || undefined,
        type: ['parent-child', 'related', 'prerequisite'].includes(e.type) ? e.type : 'parent-child',
      }));

      mindMap.nodes = nodes;
      mindMap.edges = edges;
      mindMap.totalNodes = nodes.length;
      mindMap.status = 'ready';
      mindMap.generatedAt = new Date();
      await mindMap.save();

      try {
        const { notificationQueue } = require('../config/queue');
        await notificationQueue.add('send', {
          userId,
          title: 'Mind map ready!',
          body: `A concept map with ${nodes.length} nodes was generated from "${content.title}".`,
          data: { type: 'mindmap_ready', mindMapId: mindMap._id.toString(), contentId },
        });
      } catch {}

      return mindMap;
    } catch (err) {
      mindMap.status = 'failed';
      await mindMap.save();
      throw err;
    }
  }

  async getUserMindMaps(userId, { page = 1, limit = 20 } = {}) {
    const skip = (page - 1) * limit;
    const [maps, total] = await Promise.all([
      MindMap.find({ userId, status: 'ready' })
        .populate('contentId', 'title domain contentType thumbnailURL')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MindMap.countDocuments({ userId, status: 'ready' }),
    ]);
    return { items: maps, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getMindMap(userId, mindMapId) {
    const map = await MindMap.findOne({ _id: mindMapId, userId })
      .populate('contentId', 'title domain contentType')
      .lean();
    if (!map) throw new ApiError(404, 'Mind map not found');
    return map;
  }

  async deleteMindMap(userId, mindMapId) {
    const result = await MindMap.findOneAndDelete({ _id: mindMapId, userId });
    if (!result) throw new ApiError(404, 'Mind map not found');
    return { deleted: true };
  }
}

module.exports = new MindMapGenerationService();
