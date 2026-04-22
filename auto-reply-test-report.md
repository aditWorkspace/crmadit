# Auto-Reply Pipeline Test Report

Generated: 2026-04-22T01:01:05.361Z

## Summary

| Action | Count |
|--------|-------|
| SEND (auto-reply) | 10 |
| FOUNDER (manual) | 24 |
| SKIP (no action) | 6 |
| **Total** | 40 |

---

## Test Results

### Test 1: positive_enthusiastic

**Contact:** Sarah Chen @ Stripe

**Input Email:**
> Yes! Would love to chat. This sounds really interesting.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_enthusiastic` (confidence: 0.98)
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_enthusiastic

**Generated Reply:**
```
Hi Sarah,

Thanks for being open to this.

https://pmcrminternal.vercel.app/book

Grab any time that works.

Best,
Adit
```

---

### Test 2: positive_casual

**Contact:** Mike Rodriguez @ Notion

**Input Email:**
> Sure, happy to chat.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.95)
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_casual

**Generated Reply:**
```
Hi Mike,

Thanks for being open to this.

https://pmcrminternal.vercel.app/book

Grab any time that works.

Best,
Adit
```

---

### Test 3: positive_send_times

**Contact:** Emma Wilson @ Figma

**Input Email:**
> Sounds good. Send me some times that work for you.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_send_times` (confidence: 0.98)
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: positive_send_times

**Generated Reply:**
```
Hi Emma,

Perfect, thanks for being open to this.

https://pmcrminternal.vercel.app/book

Grab any time that works.

Best,
Adit
```

---

### Test 4: positive_specific_day

**Contact:** James Park @ Airbnb

**Input Email:**
> How about Tuesday afternoon? I have some time around 2-4pm PT.

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
Hi James,

Perfect, Tuesday 2-4pm PT works great for me. Let me grab a specific slot.

https://pmcrminternal.vercel.app/book

Thanks James, really looking forward to it.

Best,
Adit
```

---

### Test 5: positive_calendly_request

**Contact:** Lisa Wang @ Plaid

**Input Email:**
> Sure thing. Do you have a Calendly or booking link?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.96)
  - Secondary: positive_calendly_request
  - Questions detected: do you have a calendly or booking link
- Edge Detector: SAFE (score: 9.8/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 9/10

**Final Action:** `SEND`
**Reason:** categories: positive_casual, positive_calendly_request

**Generated Reply:**
```
Hi Lisa,

Thanks for being open to this.

https://pmcrminternal.vercel.app/book

Grab any time that works.

Best,
Adit
```

---

### Test 6: positive_plus_how_found

**Contact:** Faisal Ahmed @ Ramp

**Input Email:**
> Yes we could jump on a call next week. Out of curiosity how did you come across our company?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.94)
  - Secondary: info_how_found
  - Questions detected: how did you come across our company
- Edge Detector: SAFE (score: 9.3/10)
  - Intent clarity: 10/10
  - Tone safety: 9/10
  - Request type: 8/10
  - Context fit: 10/10
  - Concerns: contains_question

**Final Action:** `SEND`
**Reason:** categories: positive_casual, info_how_found

**Generated Reply:**
```
Hi Faisal,

We were researching high-growth companies and how they think about product, and you stood out. Your work on the expense side at Ramp caught our attention.

https://pmcrminternal.vercel.app/book

Grab any time that works next week.

Best,
Adit
```

---

### Test 7: positive_plus_what_is_it

**Contact:** Rachel Kim @ Linear

**Input Email:**
> Sure, I'm down. But what exactly are you building? I'd like to know more before we chat.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.94)
  - Secondary: info_what_is_it
  - Questions detected: what are you building
- Edge Detector: UNSAFE (score: 6.1/10)
  - Intent clarity: 8/10
  - Tone safety: 6/10
  - Request type: 3/10
  - Context fit: 7/10
  - Concerns: contains specific product question we can't auto-answer, requires contextual understanding of what we're building, casual tone could mismatch with auto-reply

**Final Action:** `FOUNDER`
**Reason:** edge_detector: contains specific product question we can't auto-answer, requires contextual understanding of what we're building, casual tone could mismatch with auto-reply (6.1/10)

---

### Test 8: positive_plus_team

**Contact:** David Liu @ Vercel

**Input Email:**
> Yeah happy to connect. Who are you guys? Tell me a bit about your team.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.94)
  - Secondary: info_team
  - Questions detected: who are you, tell me about your team
- Edge Detector: UNSAFE (score: 5.6/10)
  - Intent clarity: 7/10
  - Tone safety: 6/10
  - Request type: 4/10
  - Context fit: 5/10
  - Concerns: asking for team info which may require nuanced disclosure, casual tone could mask partnership intentions, embedded questions about identity could lead to mismatched expectations

**Final Action:** `FOUNDER`
**Reason:** edge_detector: asking for team info which may require nuanced disclosure, casual tone could mask partnership intentions, embedded questions about identity could lead to mismatched expectations (5.6/10)

---

### Test 9: positive_plus_multiple_questions

**Contact:** Anna Petrova @ Brex

**Input Email:**
> Sounds interesting! A few questions: How did you find me? What are you building exactly? Are you funded?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `positive_casual` (confidence: 0.94)
  - Secondary: info_how_found, info_what_is_it, info_funding
  - Questions detected: how did you find me, what are you building exactly, are you funded
- Edge Detector: UNSAFE (score: 6.4/10)
  - Intent clarity: 9/10
  - Tone safety: 8/10
  - Request type: 2/10
  - Context fit: 6/10
  - Concerns: asking 'how did you find me' could indicate discomfort with being contacted, asking about funding status is business-sensitive information, asking 'what are you building exactly' may require nuanced response beyond auto-reply

**Final Action:** `FOUNDER`
**Reason:** edge_detector: asking 'how did you find me' could indicate discomfort with being contacted, asking about funding status is business-sensitive information, asking 'what are you building exactly' may require nuanced response beyond auto-reply (6.4/10)

---

### Test 10: async_prefer_email

**Contact:** Tom Baker @ Shopify

**Input Email:**
> I'd rather do this over email if that's ok. What did you want to discuss?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 11: async_send_info

**Contact:** Jennifer Lee @ Square

**Input Email:**
> Can you send me more info first? I want to see if this is relevant before committing to a call.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `async_send_info` (confidence: 0.95)
  - Questions detected: can you send more info
- Edge Detector: UNSAFE (score: 6.2/10)
  - Intent clarity: 7/10
  - Tone safety: 6/10
  - Request type: 4/10
  - Context fit: 8/10
  - Concerns: Asking for info we may not have pre-prepared, Implies relevance screening before commitment, Casual tone could mask skepticism

**Final Action:** `FOUNDER`
**Reason:** edge_detector: Asking for info we may not have pre-prepared, Implies relevance screening before commitment, Casual tone could mask skepticism (6.2/10)

---

### Test 12: async_busy_no_call

**Contact:** Chris Johnson @ Coinbase

**Input Email:**
> Too busy for calls right now but happy to chat over email. What's on your mind?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `async_busy_no_call` (confidence: 0.94)
  - Secondary: async_quick_questions
  - Questions detected: what's on your mind
- Edge Detector: UNSAFE (score: 5.8/10)
  - Intent clarity: 6/10
  - Tone safety: 7/10
  - Request type: 4/10
  - Context fit: 6/10
  - Concerns: contains open-ended question that requires tailored response, casual tone could mask specific needs

**Final Action:** `FOUNDER`
**Reason:** edge_detector: contains open-ended question that requires tailored response, casual tone could mask specific needs (5.8/10)

---

### Test 13: info_what_is_it

**Contact:** Michelle Torres @ DoorDash

**Input Email:**
> What is Proxi? I've never heard of you.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_what_is_it` (confidence: 0.98)
  - Questions detected: what is proxi
- Edge Detector: UNSAFE (score: 4.6/10)
  - Intent clarity: 6/10
  - Tone safety: 4/10
  - Request type: 3/10
  - Context fit: 5/10
  - Concerns: Direct question about company identity, Potential skepticism ('never heard of you'), Short reply may indicate disinterest or testing, Requires contextual explanation beyond standard reply

**Final Action:** `FOUNDER`
**Reason:** edge_detector: Direct question about company identity, Potential skepticism ('never heard of you'), Short reply may indicate disinterest or testing, Requires contextual explanation beyond standard reply (4.6/10)

---

### Test 14: info_how_found

**Contact:** Kevin Patel @ Instacart

**Input Email:**
> How did you find me? Just curious.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `info_how_found` (confidence: 0.96)
  - Questions detected: how did you find me
- Edge Detector: SAFE (score: 8/10)
  - Intent clarity: 8/10
  - Tone safety: 7/10
  - Request type: 8/10
  - Context fit: 9/10
  - Concerns: casual_tone

**Final Action:** `SEND`
**Reason:** categories: info_how_found

**Generated Reply:**
```
Hi Kevin,

We were researching high-growth companies and how they think about product, and you stood out.

Best,
Adit
```

---

### Test 15: info_why_me

**Contact:** Samantha White @ Robinhood

**Input Email:**
> Why are you reaching out to me specifically? I'm not even in product.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 16: delay_specific_date

**Contact:** Robert Garcia @ Lyft

**Input Email:**
> Reach out after May 15th. We're in the middle of a big launch right now.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_specific_date` (confidence: 0.98)
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: delay_specific_date

**Generated Reply:**
```
Hi Robert,

Totally understand, I'll circle back after May 15th. Good luck with the launch.

Best,
Adit
```

---

### Test 17: delay_next_quarter

**Contact:** Nicole Adams @ Uber

**Input Email:**
> Not a good time right now. Can you follow up next quarter?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay` (confidence: 0.95)
- Edge Detector: SAFE (score: 9.3/10)
  - Intent clarity: 10/10
  - Tone safety: 9/10
  - Request type: 8/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: delay

**Generated Reply:**
```
Hi Nicole,

Totally understand, I'll circle back next quarter. Looking forward to connecting then.

Best,
Adit
```

---

### Test 18: delay_traveling

**Contact:** Brian Thompson @ Dropbox

**Input Email:**
> I'm traveling until the end of the month. Let's connect when I'm back.

**Pipeline Results:**
- Pre-filter: skip (pattern_ooo)

**Final Action:** `SKIP`
**Reason:** prefilter: pattern_ooo

---

### Test 19: delay_busy_generic

**Contact:** Amanda Clark @ Slack

**Input Email:**
> Swamped right now. Maybe in a few weeks?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_busy_generic` (confidence: 0.95)
- Edge Detector: UNSAFE (score: 5.2/10)
  - Intent clarity: 4/10
  - Tone safety: 6/10
  - Request type: 5/10
  - Context fit: 6/10
  - Concerns: ambiguous timeline ('maybe in a few weeks'), suggests the prospect may not be fully engaged, short_reply could indicate disinterest

**Final Action:** `FOUNDER`
**Reason:** edge_detector: ambiguous timeline ('maybe in a few weeks'), suggests the prospect may not be fully engaged, short_reply could indicate disinterest (5.2/10)

---

### Test 20: delay_plus_positive

**Contact:** Steven Wright @ Zoom

**Input Email:**
> I'm interested but traveling until March 20. Can we chat after I get back?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `delay_traveling` (confidence: 0.96)
  - Secondary: positive_casual
  - Questions detected: can we chat after march 20
- Edge Detector: SAFE (score: 10/10)
  - Intent clarity: 10/10
  - Tone safety: 10/10
  - Request type: 10/10
  - Context fit: 10/10

**Final Action:** `SEND`
**Reason:** categories: delay_traveling, positive_casual

**Generated Reply:**
```
Hi Steven,

Totally understand, I'll circle back after March 20. Looking forward to chatting then.

Best,
Adit
```

---

### Test 21: decline_polite

**Contact:** Laura Martinez @ Twitter

**Input Email:**
> Thanks for reaching out but this isn't a fit for us right now. Good luck!

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `decline_polite` (confidence: 0.98)

**Final Action:** `SKIP`
**Reason:** decline: decline_polite

---

### Test 22: decline_firm

**Contact:** Mark Davis @ Meta

**Input Email:**
> Not interested.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `decline` (confidence: 0.98)

**Final Action:** `SKIP`
**Reason:** decline: decline

---

### Test 23: decline_unsubscribe

**Contact:** Karen Brown @ Google

**Input Email:**
> Please remove me from your list. Stop emailing me.

**Pipeline Results:**
- Pre-filter: skip (pattern_unsubscribe)

**Final Action:** `SKIP`
**Reason:** prefilter: pattern_unsubscribe

---

### Test 24: edge_resume

**Contact:** Alex Turner @ Netflix

**Input Email:**
> Sure! Also, I'm looking for new opportunities. Here's my resume if you're hiring.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 25: edge_linkedin

**Contact:** Maria Gonzalez @ Amazon

**Input Email:**
> Let's connect on LinkedIn first. Add me: linkedin.com/in/mariagonzalez

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 26: edge_sales_pitch

**Contact:** Jason Miller @ Salesforce

**Input Email:**
> Actually, we have a tool that might help YOU. Can I tell you about our product?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 27: edge_partnership

**Contact:** Emily Chen @ Adobe

**Input Email:**
> Yes! And we should totally partner up. Let's discuss a collaboration.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 28: edge_sarcastic

**Contact:** Derek Jones @ Apple

**Input Email:**
> lol ok whatever. I guess?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 29: edge_hostile

**Contact:** Tony Stark @ Stark Industries

**Input Email:**
> How did you get my email? This is spam. I'm reporting you.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 30: edge_one_word

**Contact:** Simple Sam @ SimpleCo

**Input Email:**
> ok

**Pipeline Results:**
- Pre-filter: founder (body_too_short)

**Final Action:** `FOUNDER`
**Reason:** prefilter: body_too_short

---

### Test 31: edge_contact_request

**Contact:** Privacy Pete @ PrivacyCorp

**Input Email:**
> Sure, what's your personal cell number? I prefer texting.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 32: edge_competitor

**Contact:** Competitor Carl @ ProductBoard

**Input Email:**
> Interesting. We actually build prioritization tools ourselves at ProductBoard. Curious what you're doing differently.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 33: question_compliance

**Contact:** Compliance Carol @ BigBank

**Input Email:**
> Are you SOC2 compliant? We can only work with vendors that meet our security requirements.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `question_compliance` (confidence: 0.95)
  - Questions detected: are you SOC2 compliant

**Final Action:** `FOUNDER`
**Reason:** classifier: question_compliance (conf: 0.95)

---

### Test 34: question_technical

**Contact:** Tech Ted @ TechCorp

**Input Email:**
> Do you integrate with Jira? What about Slack? We need API access.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `edge_random` (confidence: 0.00)

**Final Action:** `FOUNDER`
**Reason:** classifier: edge_random (conf: 0.00)

---

### Test 35: question_pricing

**Contact:** Budget Betty @ BudgetCo

**Input Email:**
> How much does it cost? What's your pricing model?

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `question_pricing` (confidence: 0.98)
  - Questions detected: how much does it cost, what is your pricing model

**Final Action:** `FOUNDER`
**Reason:** classifier: question_pricing (conf: 0.98)

---

### Test 36: referral_named

**Contact:** Referral Rick @ RefCorp

**Input Email:**
> I'm not the right person. Talk to Sarah Johnson, she handles product. Her email is sarah@refcorp.com

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `referral_named` (confidence: 0.98)

**Final Action:** `FOUNDER`
**Reason:** classifier: referral_named (conf: 0.98)

---

### Test 37: referral_unknown

**Contact:** Wrong Person Wendy @ WrongCo

**Input Email:**
> You've got the wrong person. Someone else on my team might be interested though.

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `referral_unknown` (confidence: 0.95)

**Final Action:** `FOUNDER`
**Reason:** classifier: referral_unknown (conf: 0.95)

---

### Test 38: ooo_auto_reply

**Contact:** Vacation Vic @ VacationCo

**Input Email:**
> I am currently out of the office with limited access to email. I will return on May 1st. For urgent matters, contact my colleague at backup@vacationco.com.

**Pipeline Results:**
- Pre-filter: skip (pattern_ooo)

**Final Action:** `SKIP`
**Reason:** prefilter: pattern_ooo

---

### Test 39: ooo_traveling

**Contact:** Travel Tina @ TravelCo

**Input Email:**
> Auto-reply: I'm traveling and will respond when I return on April 30th.

**Pipeline Results:**
- Pre-filter: skip (pattern_ooo)

**Final Action:** `SKIP`
**Reason:** prefilter: pattern_ooo

---

### Test 40: calendly_sent

**Contact:** Calendly Casey @ CalendarCo

**Input Email:**
> Sure! Here's my Calendly: https://calendly.com/casey-calendar/30min

**Pipeline Results:**
- Pre-filter: proceed (passed_prefilter)
- Classifier: `calendly_sent` (confidence: 0.98)
  - Secondary: positive_casual

**Final Action:** `FOUNDER`
**Reason:** classifier: calendly_sent (conf: 0.98)

---

