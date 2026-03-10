// server.js — MediGuard using Groq API + Training Data support
// Run with: node server.js

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Load training data ───────────────────────────────────
const TRAINING_DIR = path.join(__dirname, '..', 'generator', 'training-data');
let trainingExamples = [];

function loadTrainingData() {
  if (!fs.existsSync(TRAINING_DIR)) {
    fs.mkdirSync(TRAINING_DIR, { recursive: true });
    return;
  }

  trainingExamples = [];
  const files = fs.readdirSync(TRAINING_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, file), 'utf8'));
      const prompts = content.prompts || [];
      // Only load items that have category labels (not plain strings)
      for (const p of prompts) {
        if (p && typeof p === 'object' && p.prompt && p.category !== undefined) {
          trainingExamples.push(p);
        }
      }
    } catch (e) {
      console.warn(`Could not load training file: ${file}`);
    }
  }

  console.log(`Loaded ${trainingExamples.length} training examples from ${files.length} files`);
}

loadTrainingData();

// Reload training data every 60 seconds to pick up new files automatically
setInterval(loadTrainingData, 60000);

// ─── Health Check ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    training_examples: trainingExamples.length
  });
});

// ─── Helper: Call Groq API ────────────────────────────────
async function callGroq(systemPrompt, userMessage, maxTokens = 500) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  }
      ]
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`Groq API error: ${errData?.error?.message || `HTTP ${response.status}`}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// ─── Build few-shot examples from training data ───────────
function getFewShotExamples(count = 3) {
  if (trainingExamples.length === 0) return '';

  const CAT_NAMES = [
    'UNVERIFIED_DRUG_ADVICE','ALT_SOURCE_DOSAGE',
    'MISINFORMATION_RISK','ALTERNATIVE_MEDICINE','UNSAFE_SELF_TREATMENT'
  ];

  // Pick random examples
  const shuffled = [...trainingExamples].sort(() => Math.random() - 0.5).slice(0, count);

  return '\n\nExamples of threats from training data:\n' +
    shuffled.map(e => `- "${e.prompt}" → ${CAT_NAMES[Math.min(e.category, 4)]}`).join('\n');
}

// ─── Main Route ───────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const msg = message.trim();

  try {
    // ── STEP 1: FIREWALL ─────────────────────────────────
    const fewShot = getFewShotExamples(3);

    const firewallSystem = `You are a healthcare AI firewall. Classify if the user message is a threat.

Threat categories:
  0 = UNVERIFIED_DRUG_ADVICE  (unverified medications, unsafe drug claims)
  1 = ALT_SOURCE_DOSAGE       (dosages from blogs, social media, alt-medicine)
  2 = MISINFORMATION_RISK     (health misinformation, anti-vax, conspiracy theories)
  3 = ALTERNATIVE_MEDICINE    (unproven treatments presented as definitive cures)
  4 = UNSAFE_SELF_TREATMENT   (dangerous self-treatment, stopping prescribed meds)

RULES:
- Normal health questions, symptoms, general wellness = SAFE
- Only flag genuinely dangerous or misleading content${fewShot}

If SAFE respond with exactly: SAFE
If THREAT respond with only this JSON (no markdown, no extra text):
{"blocked":true,"threatType":"CATEGORY_NAME","categoryIndex":NUMBER,"message":"One sentence reason","suggestion":"What to do instead","flags":["word1","word2"]}`;

    const firewallRaw = await callGroq(firewallSystem, msg, 200);
    const upper = firewallRaw.toUpperCase().trim();

    if (!upper.startsWith('SAFE')) {
      try {
        const cleaned = firewallRaw.replace(/^```json\s*/i,'').replace(/```\s*$/i,'').trim();
        const decision = JSON.parse(cleaned);
        if (decision.blocked === true) {
          console.log(`[BLOCKED] ${decision.threatType} | "${msg.substring(0,50)}"`);
          return res.json(decision);
        }
      } catch (e) {
        console.warn('[FIREWALL PARSE WARNING]', firewallRaw);
      }
    }

    // ── STEP 2: ANSWER ───────────────────────────────────
    const answerSystem = `You are a careful, knowledgeable healthcare assistant. Answer clearly based on established medical knowledge. Always recommend consulting a qualified doctor for personal medical decisions. Keep answers concise (3-6 sentences).`;

    const answer = await callGroq(answerSystem, msg, 500);

    console.log(`[SAFE] "${msg.substring(0,50)}"`);
    return res.json({ blocked: false, response: answer });

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────
if (!GROQ_API_KEY) {
  console.error('ERROR: GROQ_API_KEY is not set in .env');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`MediGuard running at http://localhost:${PORT}`);
  console.log(`Training examples loaded: ${trainingExamples.length}`);
});