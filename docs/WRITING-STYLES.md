# Writing styles

The assistant writes mail drafts (the outbox cards and the reply drafts on tasks) for the owner. A **writing style** says how the owner
writes to someone: how he opens, how long the mail is, whether he signs, what he never says. The rules are **checked by code** on every
draft, so a stiff or over-long draft is refused before it reaches the approval card.

Code: `lib/writingstyle.js` (resolver, validator, gate, feedback), `lib/styleanalysis.js` (analysis of the owner's sent mail),
`lib/runner.js` (`styleAnalyseOnce`, `styleTryOnce`). Tests: `test/styles.test.js`, `test/styles-cli.test.js`, `scripts/test-styles-ui.js`.

## A style

| Rule | Values | Checked |
|---|---|---|
| `formality` | `casual`, `neutral`, `formal` | adds built-in forbidden phrases (e.g. casual forbids "לכבוד", "בכבוד רב", "אשמח אם תוכל") and decides mixed recipients |
| `language` | `he`, `en`, `ru`, `same-as-thread` | the dominant script of the text (for a reply: the original mail's language) |
| `greeting` / `greeting_alt` | `any`, `none`, or templates such as `{first_name}, היי`, `שלום {first_name}`; `none` in the alternatives = "or no greeting" | the first line |
| `closing` / `closing_alt` | `any`, `none`, or a text such as `תודה` | the last line |
| `signature` | `false` (the organisation adds it), `true`, `any` | the owner's name at the end |
| `max_sentences` | number or empty | hard limit |
| `max_words` | number or empty | soft: a warning above it, a refusal above 130% |
| `allow_bullets`, `emoji` | true / false | list lines, emoji |
| `forbidden_phrases`, `required_phrases` | lists | whole-word match, niqqud and quote marks normalised |
| `address` | `any`, `singular` (אתה), `plural` (אתם) | second-person forms |

Plus `description_he` (two or three lines on the tone, read by the assistant) and up to three real examples from the owner's sent mail
(they stay in the encrypted database).

A style is `active`, `proposed` (made by the analysis, not used until the owner switches it on) or `disabled`. One active style is the
default. A fresh installation has an active neutral default ("בסיס") and two switched-off templates (casual colleague, formal).

## Who gets which style

Each recipient (To and Cc) is resolved in this order, first match wins, only active styles count:

1. **person** assignment
2. **group**: the person's `style_group` (people are added to a group in the style editor)
3. **email domain** (sub-domains match)
4. **role**: `boss` (the bosses in the configuration), `pm`, `internal` (the owner's own domain and `internal_domains`), `unknown` (not in the people list), `external`
5. the **default**

Several recipients with different styles: the **most formal** one is used and the assistant is told so. Example: a mail to Dana Levi
(casual) with her manager in Cc (formal) is written in the formal style.

## The gate

`mesimot outbox draft|update`, `mesimot draft add` (an `אל: name address` first line names the recipients, otherwise the task's requester)
and the `outbox` / `drafts` parts of `mesimot apply` resolve the style and validate the text. A violation refuses the command (HTTP 422)
with a Hebrew list of what to fix, the style guide, up to five of the owner's own recent mails to those people (quoted text removed) and
what he changed in earlier drafts. The assistant rewrites and runs the command again; `--long` skips only the length rules (when the owner
asked for a long mail). A refusal is logged in `gate_log` (code `style`); if the run ends without a rewritten draft, the post-run gate asks
again. The owner's own text is never checked. The draft remembers its style (`outbox.style_key`) and the approval card shows "סגנון: <name>".

Before writing, the assistant runs `mesimot style for --to "dana.levi@example.com"` (or a name, `--reply-email ID`, `--task ID`).
`mesimot style check --to .. --body ..` validates without saving.

## Learning from the owner's edits

When the owner edits the assistant's text on the card (✏️ ערוך), the before/after is stored (`style_feedback`) with a short summary
("קיצר מ-4 ל-2 משפטים; פתיחה "שלום דנה" → "דנה, היי""). `mesimot style feedback --to ..` shows it to the assistant. Patterns that repeat
become **suggestions** in Settings → סגנונות כתיבה ("בדרך כלל אתה מקצר ל-2 משפטים לדנה לוי - לעדכן?"). Nothing is applied until the
owner presses "לעדכן". The assistant cannot change rules or assignments: `mesimot style suggest <key> --reason ..` turns its request
into such a suggestion too.

## Making styles from your own mail

The analysis reads **your sent mail of the last 12 months** (text only, quoted replies, mobile footers and the signature block removed),
measures in code (number of mails, median words, sentences, greeting forms with counts, closings, signature, language, bullets, which stiff
phrases you never use) and asks the cheap model (job `style`, no tools) for two or three lines on the tone. The result is saved as a
**proposed** style with three real excerpts; an active or owner-edited style is never overwritten. Progress is kept in the setting
`style_analysis`, so an interrupted run continues where it stopped (`--force` redoes). At most 40 model runs per call; the runs wait for
the live assistant.

```
mesimot style analyse                          # everything: the default, the configured team and bosses, every group, the boss and unknown roles
mesimot style analyse --person "Dana Levi"     # one or more people: --person "Dana Levi,Ron Shachar"
mesimot style analyse --group "Design offices" --classify "architecture and design offices"
                                               # a group: its members, its domains; --classify lets the model pick the matching
                                               # external domains once (stored, editable in Settings); or --domains a.example,b.example
mesimot style analyse --role boss              # roles: boss, unknown, pm, internal, external
mesimot style analyse --default --dry          # measure only, print the rules, save nothing
mesimot style try --to "Dana Levi" --say "ask if the plans are ready"   # a dry draft through the same guide and gate; nothing saved or sent
```

These commands are for the owner (the assistant is refused). Then open Settings → סגנונות כתיבה, review each proposal, adjust and
press "הפעלה".

## Settings screen

Settings → סגנונות כתיבה: pending suggestions (accept / dismiss), the list (name, who, status). A style opens an editor: name, short
description, dropdowns (formality, language, greeting, closing, signature, length, bullets), "who" chips (person, group, domain, role)
with add/remove, the members of each group, forbidden phrases, a preview line made from the rules (nothing is generated), the real
examples (read-only), save / activate / disable.
