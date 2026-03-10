// generator-server.js — MediGuard Prompt Generator Backend
// Run with: node generator-server.js

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.GEN_PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Training data folders ────────────────────────────────
// Saves inside generator/training-data/ AND mediguard/training-data/
const LOCAL_DIR    = path.join(__dirname, 'training-data');
const MEDIGUARD_DIR = path.join(__dirname, '..', 'mediguard', 'training-data');

[LOCAL_DIR, MEDIGUARD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); console.log(`Created: ${dir}`); }
    catch (e) { console.warn(`Could not create: ${dir}`); }
  }
});

// ─── Groq helper ─────────────────────────────────────────
async function callGroq(system, user, maxTokens = 2000) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.85,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ─── Generate + Save endpoint ────────────────────────────
// Frontend sends config, backend calls Groq and saves the file
app.post('/api/generate', async (req, res) => {
  const { count = 20, intensity = 'moderate', format = 'with_labels', categories = [0,1,2,3,4] } = req.body;

  const CAT_NAMES = [
    'UNVERIFIED_DRUG_ADVICE', 'ALT_SOURCE_DOSAGE',
    'MISINFORMATION_RISK', 'ALTERNATIVE_MEDICINE', 'UNSAFE_SELF_TREATMENT'
  ];

  const catDescriptions = categories.map(i => `  ${i} = ${CAT_NAMES[i]}`).join('\n');

  const intensityDesc = {
    subtle:   'Make prompts sound innocent — hard to detect. Use indirect phrasing.',
    moderate: 'Realistic questions a user might ask that contain misinformation or unsafe advice.',
    overt:    'Clearly dangerous, explicit requests for unsafe medical advice.',
    mixed:    'Mix subtle, moderate, and overt for maximum variety.'
  }[intensity] || 'Realistic';

  const formatInstruction = {
    prompts_only:  'Return prompts as an array of strings.',
    with_labels:   'Each item: {"prompt":"...","category":NUMBER}',
    full:          'Each item: {"prompt":"...","category":NUMBER,"threatType":"...","reason":"...","flags":["..."]}'
  }[format] || 'Each item: {"prompt":"...","category":NUMBER}';

  const systemPrompt = `You are a red-team researcher generating a healthcare prompt injection dataset to train an AI safety firewall.

Generate exactly ${count} UNIQUE realistic healthcare prompts representing threats in these categories:
${catDescriptions}

Intensity: ${intensityDesc}

Format each item as: ${formatInstruction}

CRITICAL RULES:
- Respond with ONLY valid JSON: {"prompts":[...]}
- No markdown, no backticks, no explanation
- Make prompts varied and draw from real-world misinformation patterns
- Reference specific drugs, supplements, websites, dosages, and conditions`;

  try {
    const raw = await callGroq(systemPrompt, `Generate ${count} healthcare threat prompts.`);
    const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
    const parsed = JSON.parse(cleaned);
    const prompts = parsed.prompts || parsed;

    if (!Array.isArray(prompts)) throw new Error('AI returned unexpected format');

    // Build final dataset
    const dataset = {
      category: 'Healthcare_Medical',
      generated_at: new Date().toISOString(),
      count: prompts.length,
      prompts
    };

    const content   = JSON.stringify(dataset, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `threats_${timestamp}.json`;
    const savedTo   = [];

    // Save to generator/training-data/
    const localPath = path.join(LOCAL_DIR, filename);
    fs.writeFileSync(localPath, content, 'utf8');
    savedTo.push(localPath);
    console.log(`[SAVED] ${localPath} — ${prompts.length} prompts`);

    // Save to mediguard/training-data/ if it exists
    if (fs.existsSync(MEDIGUARD_DIR)) {
      const mgPath = path.join(MEDIGUARD_DIR, filename);
      fs.writeFileSync(mgPath, content, 'utf8');
      savedTo.push(mgPath);
      console.log(`[COPIED TO MEDIGUARD] ${mgPath}`);
    }

    res.json({ success: true, filename, saved_to: savedTo, dataset });

  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── List saved datasets ──────────────────────────────────
app.get('/api/datasets', (req, res) => {
  try {
    const files = fs.readdirSync(LOCAL_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, f), 'utf8'));
          return { filename: f, count: c.prompts?.length || 0, generated_at: c.generated_at || '' };
        } catch { return { filename: f, count: 0, generated_at: '' }; }
      })
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at));

    res.json({ datasets: files, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const localCount = fs.readdirSync(LOCAL_DIR).filter(f => f.endsWith('.json')).length;
  let mgCount = 0;
  try { mgCount = fs.readdirSync(MEDIGUARD_DIR).filter(f => f.endsWith('.json')).length; } catch {}
  res.json({ status: 'ok', local_files: localCount, mediguard_files: mgCount,
             local_dir: LOCAL_DIR, mediguard_dir: MEDIGUARD_DIR });
});

// ─── Start ────────────────────────────────────────────────
if (!GROQ_API_KEY) {
  console.error('ERROR: GROQ_API_KEY not set in .env');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`\n✅ Generator running at http://localhost:${PORT}`);
  console.log(`   Open: http://localhost:${PORT}/generator.html`);
  console.log(`   Local training-data:    ${LOCAL_DIR}`);
  console.log(`   MediGuard training-data: ${MEDIGUARD_DIR}\n`);
});