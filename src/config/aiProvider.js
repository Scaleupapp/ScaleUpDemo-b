/**
 * AI Provider Abstraction Layer
 *
 * Routes requests to the appropriate LLM:
 * - GPT-4o: Content processing, quiz question generation, journey generation
 * - Claude: Objective analysis, assessment evaluation, coaching, insights
 */

const openai = require('./openai');
const anthropic = require('./anthropic');

class AIProvider {

  /**
   * Generate structured JSON using GPT-4o (for generation tasks)
   */
  async generateWithGPT({ systemPrompt, userPrompt, temperature = 0.7, maxTokens = 4000 }) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: maxTokens,
    });
    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Analyze/evaluate using Claude (for reasoning and evaluation tasks)
   */
  async analyzeWithClaude({ systemPrompt, userPrompt, temperature = 0.3, maxTokens = 8000 }) {
    const response = await anthropic.messages.create({
      // claude-sonnet-4-20250514 retired 2026-06-15; claude-sonnet-4-6 is the drop-in replacement
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });

    // Extract text content from Claude's response
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Try to parse as JSON if it looks like JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (_) {
        // Not valid JSON, return as text
      }
    }
    return { text };
  }

  /**
   * Evaluate with Claude - specifically for grading/evaluation tasks
   * Returns structured evaluation results
   */
  async evaluateWithClaude({ systemPrompt, userPrompt, temperature = 0.2, maxTokens = 6000 }) {
    return this.analyzeWithClaude({ systemPrompt, userPrompt, temperature, maxTokens });
  }
}

module.exports = new AIProvider();
