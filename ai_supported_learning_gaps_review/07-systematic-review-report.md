# Focused Review Report: AI-Supported Learning Gaps Relevant to Immersive ATC/ATM Training

## Review Snapshot

- Topic: Research gaps in AI-supported learning that an immersive ATC/ATM training application could investigate.
- Review question: Which documented gaps in current AI-supported learning research can be meaningfully investigated through a domain-grounded, instructor-guided, immersive ATC/ATM training application?
- Search date: 2026-07-22.
- Search sources: Springer Nature, ScienceDirect, Journal of Learning Analytics, PNAS, PubMed/PMC, ERIC, and university open-access repositories.
- Included studies: 12.
- Manual-access studies incorporated: Three browser-readable studies were incorporated from their publisher or repository text because automated PDF downloads were blocked.

## Search Criteria

- Search strings: AI-supported learning and systematic-review terms; teacher-AI complementarity and orchestration; AI with immersive learning; generative AI scenario generation; and AI with retention, transfer, overreliance, or learner agency.
- Inclusion criteria: A study had to document a gap relevant to instructor oversight, adaptive support, scenario generation, immersive interaction data, collaborative instruction, explainability, or learning evaluation.
- Exclusion criteria: Administrative-only AI, unsupported commentary, and work that treated engagement or usability as evidence of learning were excluded.

## Corpus Overview

- Time distribution: 2019-2025 for the core included evidence, with the search conducted in 2026.
- Common venues: Educational technology, learning analytics, HCI-adjacent AIED, immersive learning, and simulation-based professional education.
- Common study types: Systematic reviews and meta-reviews, participatory design and classroom orchestration studies, one large randomized field experiment, and expert evaluation of AI-generated scenarios.

## Research Directions

### Instructor-AI Complementarity

Holstein et al. demonstrate a participatory approach to designing real-time instructor awareness support, while Celik et al. and Alfredo et al. find that teachers and learners remain insufficiently involved across the design lifecycle of educational AI. The current ATC/ATM system can investigate this gap through its asymmetric architecture: the trainee acts in VR, while the instructor uses the desktop companion to observe shared state, approve interventions, and guide the session.

### Grounded Scenario Generation

Ghaffari et al. found that AI-generated clinical scenarios could appear realistic while still containing errors, missing information, and inconsistencies that required expert correction. For ATC/ATM, scenario generation should therefore be constrained by staged FAA data, explicit event schemas, operational rules, and instructor-defined learning objectives. The research contribution would be the design and evaluation of this human-validated workflow, not the unrestricted generation of aviation scenarios.

### Adaptive Immersive Support and Learning Analytics

Marougkas et al. identify limited adaptive content in educational VR. Celik et al. report narrow data channels in teacher-facing AI, and Sakr and Abdullah note that immersive research remains questionnaire-heavy despite the availability of behavioral traces. The prototype can combine selections, layer changes, map manipulation, task responses, timing, errors, and scenario actions. The unresolved question is whether these traces support valid and useful instructional inferences.

### Explainability, Agency, and Guardrails

Khosravi et al. and Alfredo et al. argue that educational explanations must be designed for specific stakeholders and preserve human control. Bastani et al. show that unrestricted generative assistance can improve assisted task performance while harming unassisted performance, whereas teacher-informed guardrails mitigated the harm. In this application, AI support should use prompts, questions, or suggested instructor interventions rather than directly completing a task for the learner.

### Durable Learning and Transfer

Hamilton et al. found that immersive-learning studies commonly used short interventions and rarely examined retention. Bond et al. similarly call for stronger methodological and contextual evidence in AIED. A useful ATC/ATM study program should therefore progress from immediate novice learning to delayed retention, transfer to unfamiliar chart or scenario content, and later evaluation with actual ATC trainees and instructors.

## Cross-Cutting Patterns

- Common methods: Systematic review, participatory design, teacher interviews, short controlled studies, interaction-log analysis, expert content validation, and instructor-facing dashboards.
- Common datasets: Student records and self-reports dominate general AIED; immersive systems add controller, navigation, object-selection, task, and temporal traces.
- Common evaluation setups: Usability questionnaires, perceived usefulness, immediate performance tests, and small samples are common. Delayed, unaided, collaborative, and professional-context evaluations are less common.
- Repeated limitations: Weak educator participation, limited human control, narrow or poorly validated learner data, plausible but incorrect generated content, insufficient adaptive immersive learning, and conflation of assisted performance with durable learning.

## Research Gaps Ranked for This Application

1. Instructor-in-the-loop orchestration during immersive learning. This is the strongest fit because the linked desktop/VR architecture already creates distinct instructor and trainee roles.
2. Domain-grounded and inspectable scenario generation. FAA data and structured event assets provide a basis for constraining generated scenarios and recording provenance.
3. Learning-sensitive assistance that avoids overreliance. The system can compare direct answers, guarded hints, instructor-approved interventions, and no AI assistance using unassisted outcomes.
4. Valid learner modeling from embodied and temporal traces. The application can test whether interaction patterns predict specific misconceptions or merely reflect interface behavior.
5. AI support for one-to-many collaborative instruction. Future linked sessions can examine whether AI summaries help instructors allocate attention without automating pedagogical authority.
6. Longitudinal retention and transfer in professional training. The system can support delayed and cross-scenario evaluation, but this requires access to ATC trainees, instructors, and a longer study period.

## Future Study Directions

1. Co-design the AI functions with ATC instructors and trainees, including what the system should observe, what it may infer, and which recommendations require instructor approval.
2. Build a constrained scenario-authoring workflow in which AI proposes events from explicit learning objectives and FAA-grounded assets, then records instructor review and revision.
3. Compare unrestricted assistance, scaffolded assistance, instructor-mediated assistance, and no AI assistance using both assisted practice and later unassisted assessment.
4. Validate learner-model features against instructor judgments and task outcomes before displaying mastery or risk estimates in a dashboard.
5. Test whether AI-supported cohort summaries reduce instructor workload and improve intervention timing in one-to-many linked sessions.
6. Measure immediate learning, delayed retention, and transfer to unfamiliar airspace or scenarios rather than relying on engagement and self-efficacy alone.

## Review Limitations

- This is a focused, application-oriented review rather than an exhaustive field-wide systematic review.
- Much of the evidence comes from general education, K-12 mathematics, higher education, and medical simulation rather than ATC/ATM.
- Three included full texts were reviewed through browser-accessible publisher content because automated PDF downloading was blocked.
- Several gaps are inferred by combining AIED and immersive-learning evidence; direct empirical research on AI-supported immersive ATC/ATM instruction remains limited.
