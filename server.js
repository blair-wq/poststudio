import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const client = new Anthropic();

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 8 } });

// Optional shared access code so strangers can't spend your API credit.
app.use('/api', (req, res, next) => {
  if (ACCESS_CODE && req.get('x-access-code') !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Wrong or missing access code.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function filesToBlocks(files) {
  const blocks = [];
  for (const f of files) {
    const name = f.originalname;
    if (f.mimetype === 'application/pdf') {
      blocks.push({ type: 'text', text: `Worksheet file: ${name}` });
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
    } else if (IMAGE_TYPES.includes(f.mimetype)) {
      blocks.push({ type: 'text', text: `Worksheet file (photo/scan): ${name}` });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mimetype, data: f.buffer.toString('base64') } });
    } else if (name.toLowerCase().endsWith('.docx')) {
      const { value } = await mammoth.extractRawText({ buffer: f.buffer });
      blocks.push({ type: 'text', text: `Worksheet file: ${name}\n\n${value}` });
    } else if (f.mimetype.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) {
      blocks.push({ type: 'text', text: `Worksheet file: ${name}\n\n${f.buffer.toString('utf8')}` });
    } else {
      throw new Error(`Can't read "${name}". Use PDF, image, Word (.docx) or text files.`);
    }
  }
  return blocks;
}

function profileText(p = {}) {
  const lines = [];
  if (p.name) lines.push(`Name: ${p.name}`);
  if (p.about) lines.push(`About him / what he studies / career goals: ${p.about}`);
  if (p.voice) lines.push(`How he talks and writes: ${p.voice}`);
  if (p.sample) lines.push(`A real post or message he wrote (match this voice):\n"""\n${p.sample}\n"""`);
  return lines.length ? lines.join('\n') : 'No profile given. He is a law student with no posting history. Default to a plain, curious student voice.';
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Model did not return JSON.');
  return JSON.parse(m[0]);
}

async function ask({ system, content, max_tokens = 2000 }) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens,
    system,
    messages: [{ role: 'user', content }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

const WRITING_RULES = `
You write LinkedIn posts that sound like a real person typed them on their phone, not like AI.

HARD RULES
- First person, his voice. Use the words HE used in his answers wherever possible. Keep his phrasing, even if slightly rough.
- Open with a hook that is a specific thing: a moment, a number, a surprise, a mistake, a blunt opinion. Under ~180 characters so it shows before "see more".
- Short paragraphs, 1 to 2 lines each, blank line between. Native LinkedIn rhythm. 900 to 1,500 characters total unless the content clearly needs less.
- Be concrete. Name the actual concept, number, example or scenario from the worksheet. One real detail beats three general claims.
- Take a position. Include at least one thing he genuinely thinks, including doubt or disagreement if he expressed it.
- Plain words. Write like a smart 22 year old talking, not a consultant.

BANNED (these scream AI)
- Em dashes and en dashes. Use a full stop or comma instead.
- "In today's fast-paced world", "game-changer", "unlock", "delve", "landscape", "leverage", "navigate", "journey", "testament", "crucial", "elevate", "foster", "tapestry", "dive in", "let's unpack", "here's the thing", "the real magic", "it's not just X, it's Y", "not X but Y" constructions used as a punchline.
- Lists of exactly three adjectives or three parallel phrases. Avoid tidy triplets.
- Rhetorical question openers. Hype openers like "I'm thrilled/excited/humbled to share".
- Neat moral wrap-up sentences ("Lesson: ..."), motivational closers, and "Agree?" / "Thoughts?" engagement bait. End on a real thought, an open question he actually has, or just stop.
- Emojis (unless his sample uses them, then at most one or two). No hashtag walls: 0 to 3 hashtags at the very end, lowercase-ish and specific, or none.
- Bold/markdown formatting, bullet emoji, arrows.
- Perfect symmetry. Vary sentence length. A fragment is fine. Slight imperfection is good.

LAW STUDENT CONTEXT
He is a law student posting about what he is learning. Write as a student thinking out loud, never as a practising lawyer.
- No legal advice and no confident statements about what "the law is" beyond what the worksheet says. Frame as "what we covered", "how the court reasoned", "what I'm still not sure about".
- Only name cases, statutes, sections, courts and holdings that appear in the worksheet or his answers, spelled exactly as given. Never add or "remember" a citation. If unsure, describe the principle without naming the case.
- Jurisdiction: don't assume one. Use whatever the worksheet shows.
- Don't mention real people, clients, firms, or anything from placements or internships that could breach confidentiality. Public cases from class are fine.
- The best law-student posts take a view on a rule or judgment: where the reasoning feels strong, where it feels shaky, what the rule means for ordinary people, or what he got wrong first time. Prefer that to summarising the rule.
- Skip legalese and Latin unless he used it. Explain the idea the way he'd explain it to a mate.
- He is building a reputation, so keep it thoughtful and a bit human. No dunking on judges, lecturers or other students.

Never invent facts, stats, job experience or stories that aren't in the worksheet or his answers. If something is missing, write around it.
`;

// ---------- 1. questions ----------

app.post('/api/questions', upload.array('files', 8), async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Upload at least one worksheet.' });
    const profile = JSON.parse(req.body.profile || '{}');
    const blocks = await filesToBlocks(req.files);

    const text = await ask({
      system: `You are an interviewer helping a university student turn what he learned in class into a LinkedIn post. You have his worksheet(s). Your job is to pull out what HE actually thinks, so the post sounds like him and not like a summary.

Return ONLY JSON:
{
 "topic": "short plain description of what the worksheet covers (max 12 words)",
 "key_ideas": ["2-4 of the most post-worthy concepts, problems or results from the worksheet, in plain words"],
 "questions": [ {"q": "question text", "why": "very short hint of the angle, optional"} ]
}

Write 5 questions. Rules:
- Specific to THIS worksheet (mention the actual concept/problem), never generic like "what did you learn?".
- Conversational, like a friend asking. One sentence each.
- This is law. Draw on the issue, the rule, how it was applied, the policy reasoning, and fairness in practice. Good angles: a result that feels unfair or surprising, where the court's reasoning seems weak or strong, how it would play out for a normal person, where he first got the answer wrong, which side of a split he finds more convincing.
- Mix: what surprised or annoyed him, where he got stuck or got it wrong, a real-world place he'd see this, something he disagrees with or doubts, what he'd tell a friend who hasn't done it yet.
- Easy to answer in 1 to 3 sentences. No jargon he didn't use.

About him:
${profileText(profile)}`,
      content: [...blocks, { type: 'text', text: 'Read the worksheet and give me the JSON.' }],
      max_tokens: 1500,
    });
    res.json(extractJson(text));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
});

// ---------- 2. post ----------

app.post('/api/post', upload.array('files', 8), async (req, res) => {
  try {
    const profile = JSON.parse(req.body.profile || '{}');
    const answers = JSON.parse(req.body.answers || '[]'); // [{q, a}]
    const feedback = req.body.feedback || '';
    const previous = req.body.previous || '';
    const blocks = req.files?.length ? await filesToBlocks(req.files) : [];

    const qa = answers.filter((x) => x.a?.trim()).map((x) => `Q: ${x.q}\nHis answer: ${x.a.trim()}`).join('\n\n');
    const revise = feedback
      ? `\n\nHere is the previous draft:\n"""\n${previous}\n"""\nHe wants this changed: ${feedback}\nRewrite the whole post with that change, keeping all the rules.`
      : '';

    const text = await ask({
      system: `${WRITING_RULES}\n\nAbout him:\n${profileText(profile)}\n\nReturn ONLY JSON: {"post": "the full post text with \\n\\n between paragraphs", "headline_options": ["3 very short alternative first lines"]}`,
      content: [
        ...blocks,
        { type: 'text', text: `His answers about the worksheet:\n\n${qa || '(none given)'}${revise}\n\nWrite the post.` },
      ],
      max_tokens: 1800,
    });
    const out = extractJson(text);
    out.post = out.post.replace(/\s*[—–]\s*/g, ', ');
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
});

// ---------- 3. visual ----------

app.post('/api/visual', async (req, res) => {
  try {
    const { post, profile } = req.body;
    const text = await ask({
      system: `You design the image that goes with a LinkedIn post. Pick the single clearest idea in the post and make a clean graphic card for it. The card is read in 2 seconds in a feed, so keep text tiny in quantity.

Return ONLY JSON:
{
 "layout": "stat" | "statement" | "steps" | "compare",
 "kicker": "2-4 word label in caps-friendly words, e.g. 'WEEK 6 · STATISTICS'",
 "headline": "max 10 words, plain, specific, no dashes",
 "big": "only for layout 'stat': the single number or short term to show huge (max 8 chars), else empty",
 "items": ["layout steps: 3-4 short steps (max 7 words each). layout compare: exactly 2 items, 'Before: ...' and 'After: ...' style, max 8 words each. stat: one line of context. statement: empty"],
 "footer": "${profile?.name ? profile.name : ''}"
}
Only use facts that appear in the post. No em dashes.`,
      content: [{ type: 'text', text: post }],
      max_tokens: 700,
    });
    res.json(extractJson(text));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`LinkedIn helper running on http://localhost:${port}`));
