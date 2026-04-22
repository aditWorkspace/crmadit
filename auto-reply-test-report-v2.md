# Auto-Reply Pipeline Test Report v2

**Focus:** Startups, college student context, product validation framing

Generated: 2026-04-22T03:12:37.503Z

## Summary

| Action | Count |
|--------|-------|
| SEND (auto-reply) | 18 |
| FOUNDER (manual) | 16 |
| SKIP (no action) | 1 |
| **Total** | 35 |

---

## Test Results

### Test 1: positive_enthusiastic_startup

**Contact:** Maya Patel @ Retool

**Input Email:**
> Yeah for sure! Always happy to chat with students. Send over a time.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_send_times` (confidence: 0.95)
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_send_times

**Generated Reply:**
```
Hi Maya,

Thanks! Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Whatever works for you.

Best,
Adit
```

---

### Test 2: positive_casual_startup

**Contact:** Jake Morrison @ Notion

**Input Email:**
> Sure thing, happy to help out. What works for you?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_send_times` (confidence: 0.93)
  - Questions detected: what time works for you
- Edge Detector: SAFE (score: 9.6/10)
  - Intent clarity: 10/10
  - Tone safety: 9/10
  - Request type: 10/10
  - Context fit: 9/10

**Final Action:** `SEND`
**Reason:** categories: positive_send_times

**Generated Reply:**
```
Hi Jake,

Thanks! Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Whatever works for you.

Best,
Adit
```

---

### Test 3: positive_warm_startup

**Contact:** Priya Sharma @ Loom

**Input Email:**
> Love that you guys are doing customer discovery! Happy to chat. Do you have a calendly?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_calendly_request` (confidence: 0.96)
  - Questions detected: do you have a calendly
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_calendly_request

**Generated Reply:**
```
Hi Priya,

Thanks so much, Priya! Really appreciate the enthusiasm.

Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Whatever time works best for you. Looking forward to it!

Best,
Adit
```

---

### Test 4: positive_specific_time

**Contact:** Ryan Chen @ Mercury

**Input Email:**
> How about Thursday at 3pm? I have 30 min free.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_specific_day` (confidence: 0.98)
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_specific_day

**Generated Reply:**
```
Hi Ryan,

Perfect, Thursday at 3pm works great for me.

Do you mind grabbing a slot on my calendar here:

https://pmcrminternal.vercel.app/book

Looking forward to it!

Best,
Adit
```

---

### Test 5: positive_next_week

**Contact:** Alicia Wong @ Amplitude

**Input Email:**
> Sure, next week works better for me. Send some times!

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_send_times` (confidence: 0.96)
- Edge Detector: SAFE (score: 9.5/10)
  - Intent clarity: 10/10
  - Tone safety: 8/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_send_times

**Generated Reply:**
```
Hi Alicia,

Thanks! Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Whatever works for you.

Best,
Adit
```

---

### Test 6: positive_plus_how_found

**Contact:** Daniel Kim @ Rippling

**Input Email:**
> Sure, happy to chat! Quick question though - how did you find me?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.94)
  - Secondary: info_how_found
  - Questions detected: how did you find me
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_casual, info_how_found

**Generated Reply:**
```
Hi Daniel,

Your company stood out when we were researching how high-growth teams think about product prioritization. Thought there was no harm in reaching out!

Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Really appreciate it.

Best,
Adit
```

---

### Test 7: positive_plus_what_building

**Contact:** Sophie Zhang @ Vanta

**Input Email:**
> Yeah I could do a quick call. What exactly are you guys working on?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.94)
  - Secondary: info_what_is_it
  - Questions detected: what are you guys working on
- Edge Detector: SAFE (score: 8.5/10)
  - Intent clarity: 9/10
  - Tone safety: 8/10
  - Request type: 8/10
  - Context fit: 9/10

**Final Action:** `SEND`
**Reason:** categories: positive_casual, info_what_is_it

**Generated Reply:**
```
Hi Sophie,

Thanks so much! Me and a couple friends at Berkeley are exploring building something for PMs around product prioritization. We're still super early, mostly just doing customer discovery calls to learn from people like you about how you think about this stuff.

Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Really appreciate it.

Best,
Adit
```

---

### Test 8: positive_plus_berkeley

**Contact:** Marcus Lee @ Ramp

**Input Email:**
> Go Bears! Happy to help a fellow Cal student. What are you building?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_enthusiastic` (confidence: 0.95)
  - Secondary: info_what_is_it
  - Questions detected: what are you building
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_enthusiastic, info_what_is_it

**Generated Reply:**
```
Hi Marcus,

Go Bears! Thanks so much Marcus, really appreciate it.

Me and a couple friends at Berkeley are exploring building something for PMs around product prioritization. We're still super early, mostly just doing customer discovery calls to learn from people like you. We've been talking to PMs at different companies and realized there's a lot of nuance in how teams actually think about what ships and what doesn't.

Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Would love to pick your brain about how you think about prioritization at Ramp. Thanks again!

Best,
Adit
```

---

### Test 9: positive_plus_funding

**Contact:** Jessica Park @ Brex

**Input Email:**
> Sure! Are you guys funded or still bootstrapping? Either way happy to chat.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.93)
  - Secondary: info_funding
  - Questions detected: are you funded or bootstrapping
- Edge Detector: SAFE (score: 9.1/10)
  - Intent clarity: 10/10
  - Tone safety: 8/10
  - Request type: 9/10
  - Context fit: 9/10

**Final Action:** `SEND`
**Reason:** categories: positive_casual, info_funding

**Generated Reply:**
```
Hi Jessica,

Self-funded right now, just focused on talking to people and learning before we build anything serious.

Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Really appreciate it!

Best,
Adit
```

---

### Test 10: async_prefer_email

**Contact:** Kevin Wu @ Linear

**Input Email:**
> I'd prefer to do this over email if that's cool. What did you want to know?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `async_prefer_email` (confidence: 0.94)
  - Secondary: async_quick_questions
  - Questions detected: what did you want to know
- Edge Detector: SAFE (score: 8.5/10)
  - Intent clarity: 9/10
  - Tone safety: 8/10
  - Request type: 9/10
  - Context fit: 8/10

**Final Action:** `SEND`
**Reason:** categories: async_prefer_email, async_quick_questions

**Generated Reply:**
```
Hi Kevin,

Totally get it, happy to do this over email!

Me and a couple friends at Berkeley are exploring building something for PMs around product prioritization. We're still super early, mostly just doing customer discovery to understand the space better.

A few things we're curious about: How do you currently decide what makes it onto Linear's roadmap each quarter? And what's the main source of signal you rely on, customer feedback, usage data, or something else? Last one, what's the most frustrating part of the prioritization process for you?

Would love to hear your thoughts whenever you have time.

Best,
Adit
```

---

### Test 11: async_send_info

**Contact:** Rachel Torres @ Figma

**Input Email:**
> Can you send me a quick overview first? Want to make sure I can actually help.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `async_send_info` (confidence: 0.94)
  - Questions detected: can you send me a quick overview
- Edge Detector: SAFE (score: 8.5/10)
  - Intent clarity: 9/10
  - Tone safety: 8/10
  - Request type: 8/10
  - Context fit: 9/10
  - Concerns: request for overview might require manual verification

**Final Action:** `SEND`
**Reason:** categories: async_send_info

**Generated Reply:**
```
Hi Rachel,

Me and a couple friends at Berkeley are exploring building something for PMs around product prioritization. We're still super early, mostly just doing customer discovery to learn from people like you.

We're not trying to build some magic bullet or anything, just genuinely curious how experienced PMs like you think about what makes it onto the roadmap. What frameworks do you use? Where do you get your signal from? How does it actually work in practice at a company like Figma?

That's basically it. No pitch, no demo, just want to learn from people doing this well. If you're open to chatting about it at some point, totally understand if not. But figured it was worth asking since you've probably seen a lot of different approaches to prioritization.

Best,
Adit
```

---

### Test 12: async_busy

**Contact:** Chris Anderson @ Vercel

**Input Email:**
> Super busy with launches right now. Happy to answer questions over email though. What's on your mind?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `async_busy_no_call` (confidence: 0.93)
  - Secondary: async_quick_questions
  - Questions detected: what is on your mind
- Edge Detector: UNSAFE (score: 4.4/10)
  - Intent clarity: 3/10
  - Tone safety: 7/10
  - Request type: 3/10
  - Context fit: 5/10
  - Concerns: Open-ended question ('What's on your mind?') with no clear positive signal for a call, No commitment to engage beyond email, Too vague for a safe standardized response

**Final Action:** `FOUNDER`
**Reason:** edge_detector: Open-ended question ('What's on your mind?') with no clear positive signal for a call, No commitment to engage beyond email, Too vague for a safe standardized response (4.4/10)

---

### Test 13: async_quick_questions

**Contact:** Emma Davis @ Clerk

**Input Email:**
> I've only got time for email right now. What specific questions do you have?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `async_prefer_email` (confidence: 0.94)
  - Secondary: async_quick_questions
  - Questions detected: what specific questions do you have
- Edge Detector: SAFE (score: 8.3/10)
  - Intent clarity: 8/10
  - Tone safety: 8/10
  - Request type: 9/10
  - Context fit: 8/10

**Final Action:** `SEND`
**Reason:** categories: async_prefer_email, async_quick_questions

**Generated Reply:**
```
Hi Emma,

Totally get it, happy to do this over email!

Me and a couple friends at Berkeley are exploring building something for PMs around product prioritization. We're still super early, mostly just doing customer discovery to understand the space better.

A few quick ones if you don't mind: How do you currently decide what makes it onto the roadmap each quarter? And what's the main source of signal you rely on, customer feedback, usage data, or something else? Last one, what's the most frustrating part of the prioritization process for you?

No pressure if you're swamped, but would genuinely help us learn how experienced PMs think about this stuff.

Best,
Adit
```

---

### Test 14: info_how_found

**Contact:** Tom Wright @ Airbyte

**Input Email:**
> How did you come across my email?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_how_found` (confidence: 0.98)
  - Questions detected: how did you find my email
- Edge Detector: SAFE (score: 8.5/10)
  - Intent clarity: 9/10
  - Tone safety: 7/10
  - Request type: 10/10
  - Context fit: 8/10
  - Concerns: skeptical_tone

**Final Action:** `SEND`
**Reason:** categories: info_how_found

**Generated Reply:**
```
Hi Tom,

Your company stood out when we were researching how high-growth teams think about product prioritization. We were looking at companies like Airbyte that are scaling fast and doing interesting things with their roadmaps, and your name kept coming up. Thought there was no harm in reaching out and learning from someone actually doing this work.

Best,
Adit
```

---

### Test 15: info_what_is_it

**Contact:** Lisa Chang @ dbt Labs

**Input Email:**
> What's this about? I don't think I've heard of you.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_what_is_it` (confidence: 0.88)
  - Secondary: info_how_found
  - Questions detected: what is this about, who are you
- Edge Detector: UNSAFE (score: 4.3/10)
  - Intent clarity: 5/10
  - Tone safety: 3/10
  - Request type: 4/10
  - Context fit: 5/10
  - Concerns: skeptical_tone, no_positive_signal, open-ended_question

**Final Action:** `FOUNDER`
**Reason:** edge_detector: skeptical_tone, no_positive_signal, open-ended_question (4.3/10)

---

### Test 16: info_why_me

**Contact:** Ben Miller @ Posthog

**Input Email:**
> Why me specifically? I work on analytics not product.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_why_me` (confidence: 0.88)
  - Secondary: decline_wrong_person
  - Questions detected: why are you reaching out to me specifically, what makes you think I'm the right person
- Edge Detector: UNSAFE (score: 4.3/10)
  - Intent clarity: 5/10
  - Tone safety: 3/10
  - Request type: 4/10
  - Context fit: 5/10
  - Concerns: skeptical_tone, wrong_person, potentially_embarrassing

**Final Action:** `FOUNDER`
**Reason:** edge_detector: skeptical_tone, wrong_person, potentially_embarrassing (4.3/10)

---

### Test 17: delay_specific_date

**Contact:** Anna Wilson @ Notion

**Input Email:**
> Can you reach out again after June 1st? Swamped with a big release right now.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_specific_date` (confidence: 0.96)
  - Secondary: delay_busy_generic
- Edge Detector: SAFE (score: 9/10)
  - Intent clarity: 9/10
  - Tone safety: 9/10
  - Request type: 10/10
  - Context fit: 8/10

**Final Action:** `SEND`
**Reason:** categories: delay_specific_date, delay_busy_generic

**Generated Reply:**
```
Hi Anna,

Got it, totally understand! I'll circle back after June 1st. Good luck with the big release, that sounds intense.

Best,
Adit
```

---

### Test 18: delay_next_month

**Contact:** James Chen @ Stripe

**Input Email:**
> Not a good time right now. Can you follow up next month?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_busy_generic` (confidence: 0.93)
- Edge Detector: UNSAFE (score: 5.6/10)
  - Intent clarity: 6/10
  - Tone safety: 7/10
  - Request type: 5/10
  - Context fit: 4/10
  - Concerns: timeline specificity, no positive engagement, potential for missed context

**Final Action:** `FOUNDER`
**Reason:** edge_detector: timeline specificity, no positive engagement, potential for missed context (5.6/10)

---

### Test 19: delay_traveling

**Contact:** Maria Lopez @ Plaid

**Input Email:**
> I'm traveling for the next two weeks. Let's connect when I'm back!

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_traveling` (confidence: 0.95)
  - Secondary: positive_casual
- Edge Detector: SAFE (score: 9.8/10)
  - Intent clarity: 10/10
  - Tone safety: 9/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: delay_traveling, positive_casual

**Generated Reply:**
```
Hi Maria,

Totally understand, travel happens! I'll reach out when you're back in a couple weeks. Safe travels!

Best,
Adit
```

---

### Test 20: delay_busy_positive

**Contact:** David Park @ Segment

**Input Email:**
> Interested but crazy busy right now. Can we reconnect in a few weeks?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_busy_generic` (confidence: 0.94)
  - Secondary: positive_casual
- Edge Detector: SAFE (score: 8.8/10)
  - Intent clarity: 9/10
  - Tone safety: 8/10
  - Request type: 9/10
  - Context fit: 9/10
  - Concerns: mentions_timeline, casual_tone

**Final Action:** `SEND`
**Reason:** categories: delay_busy_generic, positive_casual

**Generated Reply:**
```
Hi David,

Totally get it, I know how it is. I'll circle back in a few weeks when things calm down a bit.

Really appreciate you getting back to us though!

Best,
Adit
```

---

### Test 21: decline_polite

**Contact:** Sarah Johnson @ Databricks

**Input Email:**
> Thanks for reaching out but I don't think I'm the right fit for this. Good luck!

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `decline_polite` (confidence: 0.96)

**Final Action:** `SKIP`
**Reason:** decline: decline_polite

---

### Test 22: decline_no_time

**Contact:** Mike Brown @ Snowflake

**Input Email:**
> Sorry, I really don't have bandwidth for calls right now.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_busy_generic` (confidence: 0.88)
- Edge Detector: UNSAFE (score: 4.3/10)
  - Intent clarity: 8/10
  - Tone safety: 5/10
  - Request type: 0/10
  - Context fit: 3/10
  - Concerns: No positive signal, Explicit rejection, No embedded question to answer

**Final Action:** `FOUNDER`
**Reason:** edge_detector: No positive signal, Explicit rejection, No embedded question to answer (4.3/10)

---

### Test 23: edge_job_seeking

**Contact:** Alex Turner @ Airbnb

**Input Email:**
> Are you guys looking for interns or jobs? I'm graduating soon!

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_resume` (confidence: 0.98)
  - Questions detected: are you hiring, are you looking for interns

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_resume (conf: 0.98)

---

### Test 24: edge_job_question

**Contact:** Jordan Lee @ Lyft

**Input Email:**
> Is this some kind of job application? Are you guys hiring?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_resume` (confidence: 0.94)
  - Questions detected: are you guys hiring, is this a job application

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_resume (conf: 0.94)

---

### Test 25: edge_sales_pitch

**Contact:** Nicole Adams @ Uber

**Input Email:**
> Is this a sales pitch? What are you trying to sell me?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_skeptical` (confidence: 0.96)
  - Questions detected: is this a sales pitch, what are you trying to sell

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_skeptical (conf: 0.96)

---

### Test 26: edge_skeptical

**Contact:** Brian Wilson @ DoorDash

**Input Email:**
> How did you get my email? This seems like spam.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_skeptical` (confidence: 0.88)
  - Secondary: info_how_found
  - Questions detected: how did you get my email

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_skeptical (conf: 0.88)

---

### Test 27: edge_class_project

**Contact:** Katie Smith @ Instacart

**Input Email:**
> Is this for a class project or something?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_what_is_it` (confidence: 0.93)
  - Questions detected: is this for a class project
- Edge Detector: UNSAFE (score: 4.2/10)
  - Intent clarity: 4/10
  - Tone safety: 3/10
  - Request type: 5/10
  - Context fit: 5/10
  - Concerns: skeptical_tone, ambiguous_intent, potentially_dismissive

**Final Action:** `FOUNDER`
**Reason:** edge_detector: skeptical_tone, ambiguous_intent, potentially_dismissive (4.2/10)

---

### Test 28: edge_sarcastic

**Contact:** Tyler Johnson @ Robinhood

**Input Email:**
> lol product prioritization huh? Sure why not

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.95)
- Edge Detector: SAFE (score: 8.8/10)
  - Intent clarity: 9/10
  - Tone safety: 7/10
  - Request type: 10/10
  - Context fit: 9/10
  - Concerns: casual_tone

**Final Action:** `SEND`
**Reason:** categories: positive_casual

**Generated Reply:**
```
Hi Tyler,

Haha thanks for being down!

Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Whatever works for you. Really appreciate it.

Best,
Adit
```

---

### Test 29: referral_with_contact

**Contact:** Jennifer Wu @ Coinbase

**Input Email:**
> I'm not the right person for this. Try reaching out to our PM lead, David Chen - david@coinbase.com

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `referral_named` (confidence: 0.98)

**Final Action:** `FOUNDER`
**Reason:** classifier: referral_named (conf: 0.98)

---

### Test 30: referral_vague

**Contact:** Steve Miller @ Square

**Input Email:**
> You've got the wrong person. Maybe try someone on the product team?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `referral_unknown` (confidence: 0.88)

**Final Action:** `FOUNDER`
**Reason:** classifier: referral_unknown (conf: 0.88)

---

### Test 31: calendly_sent

**Contact:** Amy Chang @ Asana

**Input Email:**
> Sure! Book some time here: https://calendly.com/amychang/30min

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `calendly_sent` (confidence: 0.98)

**Final Action:** `FOUNDER`
**Reason:** classifier: calendly_sent (conf: 0.98)

---

### Test 32: question_what_tool

**Contact:** Michael Roberts @ Okta

**Input Email:**
> What exactly is the tool? Does it integrate with Jira?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_what_is_it` (confidence: 0.93)
  - Secondary: question_technical
  - Questions detected: what exactly is the tool, does it integrate with jira
- Edge Detector: SAFE (score: 8.5/10)
  - Intent clarity: 9/10
  - Tone safety: 9/10
  - Request type: 8/10
  - Context fit: 8/10

**Final Action:** `SEND`
**Reason:** categories: info_what_is_it, question_technical

**Generated Reply:**
```
Hi Michael,

Me and a couple friends at Berkeley are exploring building something for PMs around product prioritization. We're still super early, mostly just doing customer discovery calls to understand the space better.

Honestly, we haven't nailed down the exact shape of it yet, which is kind of why we want to talk to people like you. We're trying to understand the biggest pain points in how PMs actually prioritize work day-to-day. Is it coordinating across stakeholders? Keeping track of all the signals? Something else entirely?

On the Jira integration front, that's a great question and definitely something we're thinking about. Before we go down any technical path though, we want to make sure we're solving something that actually matters. Would love to hear how you currently think about prioritization and what tools you're already using. That'll help us figure out if something like a Jira integration even makes sense.

Do you have 20-30 minutes to chat about this? Do you mind grabbing a slot here:

https://pmcrminternal.vercel.app/book

Really appreciate it!

Best,
Adit
```

---

### Test 33: question_pricing

**Contact:** Lauren Taylor @ Twilio

**Input Email:**
> How much does it cost?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `question_pricing` (confidence: 0.98)
  - Questions detected: how much does it cost

**Final Action:** `FOUNDER`
**Reason:** classifier: question_pricing (conf: 0.98)

---

### Test 34: short_reply_positive

**Contact:** Nick Brown @ Zapier

**Input Email:**
> Sure

**Pipeline Results:**
- Pre-filter: founder (body_too_short)

**Final Action:** `FOUNDER`
**Reason:** prefilter: body_too_short

---

### Test 35: short_reply_ambiguous

**Contact:** Sara Lee @ Airtable

**Input Email:**
> Maybe

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_one_word` (confidence: 0.88)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_one_word (conf: 0.88)

---

