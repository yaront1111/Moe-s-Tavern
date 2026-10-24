# Baseline outcome report

Acceptance = held-out assessment only; Moe task status is record-only.
Token observations are not monetary cost or quota.

## Inputs
- Record version: 1
- Expected manifest: corpus version 1, 20 workload(s)
- Corpus versions: 1
- Moe commits: 6eb56809b4038945cfc09f95c3b9138f107dc62f
- Wall-clock caps (ms): 3600000
- Repetitions planned: 1
- Platforms: linux
- Node versions: v24.21.0
- CLI versions: 2.1.285 (Claude Code)
- Roles:
  - architect claude model=claude-opus-5-5 effort=max
  - worker claude model=claude-opus-5-5 effort=xhigh
  - worker claude model=claude-sonnet-5-5 effort=high
  - worker claude model=claude-sonnet-5-5 effort=xhigh
  - qa claude model=unknown effort=xhigh
- Workloads:
  - maintenance-truncation-helper-reuse: case sha256:7ca24b2f1f427b816d4700d0e1d7fd693ae1ea19fff9fb6bd9641318ac57c8cb, snapshot sha256:74fe9255d91e09943d2569874968f057328d7484277089e663ad253649ea940c
  - maintenance-branch-policy-message: case sha256:23fbd55723374c6fefe4ff21521985a0527403e06567cc73103d21dccd373d88, snapshot sha256:064e4ee0f757eff74b2000edde291be02f547e267a74be61a25d9612de82dc00
  - maintenance-usage-unknown-format: case sha256:e4ccdcdf1b5e0a6c53d7b5ec064ca6599ca37165afc3a81f3ef6881d4eec4647, snapshot sha256:69d44cfe994f8b6254b8425670f0f0580b04a901ca619961d71aa9d04c0c3c7e
  - maintenance-affected-file-caller: case sha256:8453abf76b28151ad6ba70e2ddd1824aef135c348feba799b01a42a6bce4cc47, snapshot sha256:21e5fc46af2e96624f1fa2c89da43f5c5b2f041a4be4ca8c8a3164525b941174
  - maintenance-cached-ref-caller: case sha256:979820d5b41ee97cc5acbac100ff7ec8a991ecd7de18d270f674250a50a46e68, snapshot sha256:b852af8b5cf5b2fd1f231c00d09cd86be3e8f6181f808489736ddfda5b1da0da
  - defect-stale-positive-readiness-helper: case sha256:89956a3f4e393e3b2bec64015f1d14c80cc0f565dafcf7f6c93ff21b0400bdd0, snapshot sha256:a7d0e23a53eeffe7e4e3be9b503f754a1a17f893c68f6c4d7ac3f5ff8acb1ed2
  - defect-stale-negative-integer-option: case sha256:7a26ee158bbb3910cc88766c49a6abf81944d13bac605240190ac45293057999, snapshot sha256:e9171de0afdc5892580f0a3d8cad0c44ede26654ebf22176ca90acbb0a3d8507
  - defect-changed-caller-chat-budget: case sha256:8ebb706f66d6bc9878d97813d5693d97c6c8f2afda4e19abaa2ffd90d4b98e82, snapshot sha256:048074df673a8408d102072e6c63f2c5eafd9899a7d9cf5f517583155a2f0e8f
  - defect-changed-requirements-delivery-policy: case sha256:bf3ad5151e9fd7781c4d3dd49f811565865bbf93924d011f986da996b37b8fdd, snapshot sha256:149c04a0e49ba4dcf9b314ab830911a5d215df51ebab78e65de8642cc692e564
  - defect-recipe-mismatch-platform: case sha256:4eceab41f632257dbf4ff7f5fcb64ac10e0678928cc8940286ffaa6732d6c007, snapshot sha256:e39b272f899ae244598ecfd46778d9641c6d537e2a945db50f4affdc8099e62f
  - refactor-usage-counter-normalization: case sha256:0e5ded2721905748e0baba4f30dc755dd4241bc02df81bbce1ae2f0290695c9d, snapshot sha256:5c74b60fc7c72c2ce8ffa2977fd2626600be7265ccca2367682ed6cf4532da14
  - refactor-chat-budget-consolidation: case sha256:6a03fce4d6ce51d7a7b53268e9d678d142e75cc1e2c45c7429b69334cd07e15a, snapshot sha256:0ce1b0693c021866f680c7cf3d19a7ce0eec50b45a0462f6ca3f4aa49fa75a75
  - refactor-shared-path-normalization: case sha256:a386dfd1f88e0c4ea1e50252155a4f6dbf996a23c03e45f000a52105d7c78758, snapshot sha256:156e363f96e1579f871413d99978c1aac608b38b3e21207eb7da184471b4a2fa
  - refactor-detached-snapshot-returns: case sha256:45fb5a62e4971672dd0727e4453943a7cc889f5c18f8acd48150670b088b0f84, snapshot sha256:41bb7bf16a4f3f92c0cddcd555fb6c26bd3f06e45c45ffb2bae36ac1768bd110
  - refactor-utf8-bounded-tail: case sha256:ac866010f854cc7f872e5379505f396800ee9e1d4ccdd7d42221bc263a183ed6, snapshot sha256:41ee8a7ec56bb79680827e0f2df018269e4341066682dcf0cd0b3fe711710066
  - non-routine-cached-lookup-fingerprint: case sha256:fd6ef3d322a706bb3855c23776b7a9c94cf38c5d4f263c9eca5db5b128e5d7b2, snapshot sha256:3a0f68ea8263398e67cca2d065221f68c2ca3790c3f5166198320412e1bfe90f
  - non-routine-stale-negative-export-index: case sha256:c541b6039d603d28b179f0c9c55b308e262a3c211f27e6d11fa5e3c86c3afec8, snapshot sha256:1254ff6ad4c03b1240339977bf4e79dae301e2d677e3532f37ec614f1f46b16b
  - non-routine-chat-pagination-remainder: case sha256:bbbf2176047e5fd98fd15fe2e67ba5163f5a98b8378df4c72ef1f94480adca52, snapshot sha256:dd52b34def2da7e0bb28799d31c8eebff89610340f218e1b6fbbfb7ae5c0deab
  - non-routine-monotonic-attempt-generation: case sha256:caa899cf0b4eb1488f98bbe7d132e23fd984448f288632bb415d0a91e26b1c30, snapshot sha256:086d62fc4ca7f99f22f047a7e47d53442291620edce50da831234cac95350ed0
  - non-routine-cross-role-usage-rollup: case sha256:74272711900a97ac7fa8a24a5605eb08710c0c9cc0de1cab597f9658fb0c9f3f, snapshot sha256:bdf97bfc94aed0f30c6d655d6e7b834a7d8ce91c37bb71bab9c79126e83a1bca

## Workloads
| Workload | Category | Status | Acceptance | Criteria passed | Moe status (record-only) | QA rejections | Reopens | Repair attempts | Planner sessions | Source retrievals | End-to-end ms | First code change ms | Observed total tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| maintenance-truncation-helper-reuse | maintenance | completed | accepted | 5/5 | DONE | 0 | 0 | unknown | 1 | unknown | 549574 | unknown | 1238399 (+1 unknown records) |
| maintenance-branch-policy-message | maintenance | completed | accepted | 4/4 | DONE | 0 | 0 | unknown | 1 | unknown | 552539 | unknown | 1150117 (+1 unknown records) |
| maintenance-usage-unknown-format | maintenance | completed | accepted | 6/6 | DONE | 0 | 0 | unknown | 1 | unknown | 558109 | unknown | 1318494 (+1 unknown records) |
| maintenance-affected-file-caller | maintenance | completed | accepted | 6/6 | DONE | 0 | 0 | unknown | 1 | unknown | 630183 | unknown | 1529305 (+1 unknown records) |
| maintenance-cached-ref-caller | maintenance | completed | accepted | 5/5 | DONE | 0 | 0 | unknown | 1 | unknown | 858429 | unknown | 2230337 (+1 unknown records) |
| defect-stale-positive-readiness-helper | defect | completed | accepted | 6/6 | DONE | 0 | 0 | unknown | 1 | unknown | 628829 | unknown | 1122710 (+1 unknown records) |
| defect-stale-negative-integer-option | defect | completed | accepted | 5/5 | DONE | 0 | 0 | unknown | 1 | unknown | 558594 | unknown | 1227933 (+1 unknown records) |
| defect-changed-caller-chat-budget | defect | completed | accepted | 5/5 | DONE | 0 | 0 | unknown | 1 | unknown | 601835 | unknown | 1973390 (+1 unknown records) |
| defect-changed-requirements-delivery-policy | defect | completed | accepted | 5/5 | DONE | 0 | 0 | unknown | 1 | unknown | 479192 | unknown | 1577505 (+1 unknown records) |
| defect-recipe-mismatch-platform | defect | completed | accepted | 5/5 | DONE | 0 | 0 | unknown | 1 | unknown | 1001821 | unknown | 2517758 (+1 unknown records) |
| refactor-usage-counter-normalization | refactor | completed | accepted | 3/3 | DONE | 0 | 0 | unknown | 1 | unknown | 723092 | unknown | 1959420 (+1 unknown records) |
| refactor-chat-budget-consolidation | refactor | completed | accepted | 4/4 | DONE | 0 | 0 | unknown | 1 | unknown | 709555 | unknown | 2512542 (+1 unknown records) |
| refactor-shared-path-normalization | refactor | completed | accepted | 4/4 | DONE | 0 | 0 | unknown | 1 | unknown | 925537 | unknown | 2230297 (+1 unknown records) |
| refactor-detached-snapshot-returns | refactor | completed | accepted | 4/4 | DONE | 0 | 0 | unknown | 1 | unknown | 532568 | unknown | 1454251 (+1 unknown records) |
| refactor-utf8-bounded-tail | refactor | completed | accepted | 4/4 | DONE | 0 | 0 | unknown | 1 | unknown | 732501 | unknown | 2043225 (+1 unknown records) |
| non-routine-cached-lookup-fingerprint | non-routine | completed | accepted | 6/6 | DONE | 0 | 0 | unknown | 1 | unknown | 1089388 | unknown | 2796191 (+1 unknown records) |
| non-routine-stale-negative-export-index | non-routine | completed | accepted | 6/6 | DONE | 0 | 0 | unknown | 1 | unknown | 896393 | unknown | 3088832 (+1 unknown records) |
| non-routine-chat-pagination-remainder | non-routine | completed | accepted | 7/7 | DONE | 0 | 0 | unknown | 1 | unknown | 551302 | unknown | 1440405 (+1 unknown records) |
| non-routine-monotonic-attempt-generation | non-routine | completed | accepted | 6/6 | DONE | 0 | 0 | unknown | 1 | unknown | 789131 | unknown | 2402241 (+1 unknown records) |
| non-routine-cross-role-usage-rollup | non-routine | completed | accepted | 7/7 | DONE | 0 | 0 | unknown | 1 | unknown | 1098332 | unknown | 3112970 (+1 unknown records) |

## Summary
- Workloads: 20; completed 20, capped 0, failed 0, aborted 0, missing 0
- Acceptance (held-out assessment): accepted 20, rejected 0, not assessed 0
- maintenance: 5 workload(s); accepted 5, rejected 0, not assessed 0
- defect: 5 workload(s); accepted 5, rejected 0, not assessed 0
- refactor: 5 workload(s); accepted 5, rejected 0, not assessed 0
- non-routine: 5 workload(s); accepted 5, rejected 0, not assessed 0
- Observed total tokens: 38926322 (+20 unknown records); workloads with unknown usage: 0
- Observed input 37576639 (+20 unknown records); cache read 34741216 (+20 unknown records); cache write 2834165 (+20 unknown records); uncached input 1258 (+20 unknown records); output 1349683 (+20 unknown records); reasoning (subset of output) unknown (+60 unknown records)
- Observed tokens per accepted change: 1946316.1 (incomplete usage coverage)

## Limitations
- One run per workload (n=1): no variability or confidence estimate is possible.
- Runs not completed: 0 capped, 0 failed, 0 aborted, 0 missing; every run is reported as a row and capped runs keep partial counters.
- Usage covers observed log records only; participation that was not logged is missing, not zero.
- Retrieval counters are unknown for 20 workload(s).
- Latency counters are unknown for 20 workload(s).
- Moe task status, QA approvals, rejections and reopen counts are record-only; acceptance comes only from the held-out assessment.
- Token observations are not monetary cost or quota.
