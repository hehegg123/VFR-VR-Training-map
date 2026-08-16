# Research Directions

## Direction 1: Instructor-AI Complementarity in Immersive Training

- Scope: AI supports an instructor's awareness and intervention decisions during linked VR/desktop training rather than replacing the instructor or directly controlling the learner.
- Representative papers: Holstein et al. (2019); Celik et al. (2022); Alfredo et al. (2024); Kim (2024).
- Common methods: Participatory design, interviews and focus groups with teachers, classroom deployment, dashboard and awareness-tool evaluation.
- Common datasets or benchmarks: Student interaction logs, teacher observations, self-reports, performance estimates, and classroom events. There is no common benchmark for instructor-AI orchestration.
- Open problems: Defining which decisions should be automated, determining how AI recommendations fit the temporal flow of instruction, preserving instructor authority, supporting one-to-many monitoring, and involving instructors and trainees throughout design and deployment.

## Direction 2: Domain-Grounded Scenario Generation

- Scope: AI assists instructors in authoring or varying training scenarios while authoritative data, operational constraints, and expert review limit unsafe or pedagogically irrelevant output.
- Representative papers: Ghaffari et al. (2025); Bastani et al. (2025); Khosravi et al. (2022).
- Common methods: Prompted scenario generation, expert review against domain and educational criteria, comparison of generated content, and guardrail-based generation.
- Common datasets or benchmarks: Domain guidelines, instructor-authored solutions and common errors, expert rating rubrics, and authoritative operational datasets. Standardized scenario-validity benchmarks remain uncommon.
- Open problems: Separating plausible language from operational correctness, aligning generated events with learning objectives, preserving data provenance, showing instructors why a scenario was generated, and evaluating whether scenario variation improves transfer rather than only engagement.

## Direction 3: Adaptive Support in Immersive Environments

- Scope: Adapt task difficulty, information layers, prompts, and feedback using learner behavior in an embodied spatial task.
- Representative papers: Marougkas et al. (2024); Sakr and Abdullah (2024); Celik et al. (2022).
- Common methods: Personalized VR interventions, learner-trace analysis, questionnaires, short performance assessments, and small experimental comparisons.
- Common datasets or benchmarks: Controller interactions, task completion, selected objects, navigation traces, self-reports, and occasional physiological measures. Shared immersive-learning datasets are rare.
- Open problems: Determining which traces validly indicate understanding, adapting without removing productive difficulty, explaining adaptations, connecting learner models to instructor judgment, and validating adaptive support in vocational or safety-critical training.

## Direction 4: Explainable Learner Models and Actionable Analytics

- Scope: Convert interaction traces into claims that instructors and learners can inspect, contest, and use during instruction.
- Representative papers: Khosravi et al. (2022); Alfredo et al. (2024); Celik et al. (2022); Holstein et al. (2019).
- Common methods: Explainable-AI frameworks, open learner models, participatory interface design, awareness dashboards, and qualitative evaluation of stakeholder needs.
- Common datasets or benchmarks: Predicted mastery, errors, hints, response histories, task states, and teacher annotations. No general metric establishes that an explanation is instructionally useful.
- Open problems: Avoiding false certainty from sparse traces, presenting uncertainty, explaining recommendations differently to instructors and trainees, supporting correction of learner-model errors, and measuring whether explanations improve instructional decisions.

## Direction 5: Learning-Sensitive Guardrails and Learner Agency

- Scope: Design AI assistance that helps learners reason through a task without completing the task for them or creating dependence on the system.
- Representative papers: Bastani et al. (2025); Alfredo et al. (2024); Khosravi et al. (2022).
- Common methods: Randomized comparison of unrestricted and guarded AI assistance, analysis of learner-AI conversations, unassisted post-tests, and human-centered control frameworks.
- Common datasets or benchmarks: Assisted practice performance, unassisted assessment, interaction logs, learner perceptions, and instructor-authored solution paths.
- Open problems: Choosing when to provide hints, questions, explanations, or no assistance; fading support as competence develops; detecting overreliance; preserving learner choice; and measuring whether AI improves independent performance.

## Direction 6: Durable Learning and Transfer in Authentic Contexts

- Scope: Evaluate retention, unaided performance, and transfer from AI-supported immersive practice to later tasks and professional training stages.
- Representative papers: Hamilton et al. (2021); Bond et al. (2024); Bastani et al. (2025).
- Common methods: Short controlled interventions dominate; stronger studies use delayed post-tests, unassisted assessments, field experiments, or longitudinal data.
- Common datasets or benchmarks: Knowledge tests, task performance, completion time, errors, self-efficacy, and interaction logs. Long-term professional-training outcomes are uncommon.
- Open problems: Separating novelty and assisted performance from learning, measuring delayed retention, testing transfer to unfamiliar scenarios, studying actual instructors and trainees, and determining whether benefits persist across stages of training.

