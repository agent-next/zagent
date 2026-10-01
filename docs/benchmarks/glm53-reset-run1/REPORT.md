# Installed CLI package versus claude_code benchmark

Model: glm-5.3. Source: 98a9fc2bdc83f7c24b9856d667984742c6f11a11. Package: the previous package (version 0.0.171).
Tarball SHA-256: 0cb609f58255c659b231f8a10d992eb361a88663600bab0f3324cc31f7c919e5.
Observed: 60/60. Measurement valid: true. Acceptance passed: false.
Stop reason: unknown. Original account files unchanged: true.

This compares two clients on the same GLM Coding Plan credential and canonical API route.
Wall time includes client boot and internal retries, excludes installation and grading. Cells run serially with alternating lane order.
Both clients have fresh local profiles per cell; provider-side cache warmth is not controlled. Client prompts and internal retry policies differ.
Task oracles are withheld from the task directory, not isolated by an OS security sandbox.

## Per-cell detail

| Index | Task | Repeat | Client | Result | Full wall ms | Native token fields |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | t1_rot13 | 1 | zcode | PASS | 9498 | {"inputTokens":8679,"outputTokens":111,"cacheReadTokens":4544,"cacheWriteTokens":0} |
| 1 | t1_rot13 | 1 | claude_code | PASS | 6690 | {"input_tokens":12996,"output_tokens":138,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0} |
| 2 | t1_rot13 | 2 | claude_code | PASS | 6491 | {"input_tokens":12996,"output_tokens":131,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0} |
| 3 | t1_rot13 | 2 | zcode | PASS | 13018 | {"inputTokens":8679,"outputTokens":129,"cacheReadTokens":192,"cacheWriteTokens":0} |
| 4 | t1_rot13 | 3 | zcode | PASS | 7662 | {"inputTokens":8679,"outputTokens":120,"cacheReadTokens":2368,"cacheWriteTokens":0} |
| 5 | t1_rot13 | 3 | claude_code | PASS | 6609 | {"input_tokens":516,"output_tokens":132,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 6 | t2_fixbug | 1 | claude_code | PASS | 14028 | {"input_tokens":734,"output_tokens":375,"cache_read_input_tokens":36480,"cache_creation_input_tokens":0} |
| 7 | t2_fixbug | 1 | zcode | PASS | 17435 | {"inputTokens":17565,"outputTokens":396,"cacheReadTokens":16768,"cacheWriteTokens":0} |
| 8 | t2_fixbug | 2 | zcode | PASS | 21366 | {"inputTokens":17537,"outputTokens":283,"cacheReadTokens":13248,"cacheWriteTokens":0} |
| 9 | t2_fixbug | 2 | claude_code | PASS | 17160 | {"input_tokens":737,"output_tokens":651,"cache_read_input_tokens":36480,"cache_creation_input_tokens":0} |
| 10 | t2_fixbug | 3 | claude_code | PASS | 13898 | {"input_tokens":734,"output_tokens":473,"cache_read_input_tokens":36480,"cache_creation_input_tokens":0} |
| 11 | t2_fixbug | 3 | zcode | PASS | 16795 | {"inputTokens":17545,"outputTokens":466,"cacheReadTokens":16768,"cacheWriteTokens":0} |
| 12 | t3_toposort | 1 | zcode | PASS | 11745 | {"inputTokens":8705,"outputTokens":629,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 13 | t3_toposort | 1 | claude_code | PASS | 12179 | {"input_tokens":542,"output_tokens":741,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 14 | t3_toposort | 2 | claude_code | PASS | 13298 | {"input_tokens":542,"output_tokens":857,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 15 | t3_toposort | 2 | zcode | PASS | 23091 | {"inputTokens":8705,"outputTokens":1017,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 16 | t3_toposort | 3 | zcode | PASS | 12766 | {"inputTokens":8705,"outputTokens":607,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 17 | t3_toposort | 3 | claude_code | PASS | 12776 | {"input_tokens":542,"output_tokens":739,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 18 | t4_multifile | 1 | claude_code | PASS | 24833 | {"input_tokens":1305,"output_tokens":557,"cache_read_input_tokens":74176,"cache_creation_input_tokens":0} |
| 19 | t4_multifile | 1 | zcode | PASS | 23375 | {"inputTokens":36147,"outputTokens":560,"cacheReadTokens":34816,"cacheWriteTokens":0} |
| 20 | t4_multifile | 2 | zcode | PASS | 26674 | {"inputTokens":36232,"outputTokens":653,"cacheReadTokens":34816,"cacheWriteTokens":0} |
| 21 | t4_multifile | 2 | claude_code | PASS | 35099 | {"input_tokens":13985,"output_tokens":653,"cache_read_input_tokens":80896,"cache_creation_input_tokens":0} |
| 22 | t4_multifile | 3 | claude_code | PASS | 20785 | {"input_tokens":1072,"output_tokens":378,"cache_read_input_tokens":55104,"cache_creation_input_tokens":0} |
| 23 | t4_multifile | 3 | zcode | PASS | 34892 | {"inputTokens":36251,"outputTokens":668,"cacheReadTokens":34880,"cacheWriteTokens":0} |
| 24 | t5_json | 1 | zcode | PASS | 9078 | {"inputTokens":8690,"outputTokens":328,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 25 | t5_json | 1 | claude_code | PASS | 7301 | {"input_tokens":13007,"output_tokens":464,"cache_read_input_tokens":5504,"cache_creation_input_tokens":0} |
| 26 | t5_json | 2 | claude_code | PASS | 7359 | {"input_tokens":527,"output_tokens":416,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 27 | t5_json | 2 | zcode | PASS | 8552 | {"inputTokens":8690,"outputTokens":158,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 28 | t5_json | 3 | zcode | PASS | 8230 | {"inputTokens":8690,"outputTokens":134,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 29 | t5_json | 3 | claude_code | PASS | 11168 | {"input_tokens":527,"output_tokens":596,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 30 | t6_regex | 1 | claude_code | PASS | 13082 | {"input_tokens":18541,"output_tokens":849,"cache_read_input_tokens":0,"cache_creation_input_tokens":0} |
| 31 | t6_regex | 1 | zcode | PASS | 12866 | {"inputTokens":8720,"outputTokens":713,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 32 | t6_regex | 2 | zcode | PASS | 21530 | {"inputTokens":8720,"outputTokens":1293,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 33 | t6_regex | 2 | claude_code | PASS | 14524 | {"input_tokens":557,"output_tokens":906,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 34 | t6_regex | 3 | claude_code | PASS | 11848 | {"input_tokens":557,"output_tokens":608,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 35 | t6_regex | 3 | zcode | PASS | 9166 | {"inputTokens":8720,"outputTokens":265,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 36 | t7_cli | 1 | zcode | PASS | 9841 | {"inputTokens":8703,"outputTokens":656,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 37 | t7_cli | 1 | claude_code | PASS | 19817 | {"input_tokens":540,"output_tokens":1114,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 38 | t7_cli | 2 | claude_code | PASS | 10464 | {"input_tokens":540,"output_tokens":530,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 39 | t7_cli | 2 | zcode | incorrect | 11249 | {"inputTokens":8703,"outputTokens":551,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 40 | t7_cli | 3 | zcode | PASS | 18253 | {"inputTokens":8703,"outputTokens":969,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 41 | t7_cli | 3 | claude_code | PASS | 14227 | {"input_tokens":540,"output_tokens":1082,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 42 | t8_apiclient | 1 | claude_code | PASS | 22496 | {"input_tokens":554,"output_tokens":1579,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 43 | t8_apiclient | 1 | zcode | PASS | 23801 | {"inputTokens":8717,"outputTokens":1876,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 44 | t8_apiclient | 2 | zcode | PASS | 8632 | {"inputTokens":8717,"outputTokens":288,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 45 | t8_apiclient | 2 | claude_code | PASS | 12132 | {"input_tokens":554,"output_tokens":771,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 46 | t8_apiclient | 3 | claude_code | PASS | 8917 | {"input_tokens":554,"output_tokens":728,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 47 | t8_apiclient | 3 | zcode | PASS | 36479 | {"inputTokens":8717,"outputTokens":2747,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 48 | t9_sql | 1 | zcode | PASS | 6793 | {"inputTokens":8698,"outputTokens":116,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 49 | t9_sql | 1 | claude_code | PASS | 9449 | {"input_tokens":535,"output_tokens":549,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 50 | t9_sql | 2 | claude_code | PASS | 11241 | {"input_tokens":535,"output_tokens":422,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 51 | t9_sql | 2 | zcode | PASS | 10514 | {"inputTokens":8698,"outputTokens":354,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 52 | t9_sql | 3 | zcode | PASS | 4425 | {"inputTokens":8698,"outputTokens":132,"cacheReadTokens":8064,"cacheWriteTokens":0} |
| 53 | t9_sql | 3 | claude_code | PASS | 9271 | {"input_tokens":535,"output_tokens":363,"cache_read_input_tokens":17984,"cache_creation_input_tokens":0} |
| 54 | t10_refactor | 1 | claude_code | PASS | 57475 | {"input_tokens":3175,"output_tokens":2772,"cache_read_input_tokens":95808,"cache_creation_input_tokens":0} |
| 55 | t10_refactor | 1 | zcode | PASS | 43496 | {"inputTokens":38394,"outputTokens":1938,"cacheReadTokens":35712,"cacheWriteTokens":0} |
| 56 | t10_refactor | 2 | zcode | PASS | 50871 | {"inputTokens":39890,"outputTokens":2598,"cacheReadTokens":36288,"cacheWriteTokens":0} |
| 57 | t10_refactor | 2 | claude_code | PASS | 96227 | {"input_tokens":5263,"output_tokens":4893,"cache_read_input_tokens":100032,"cache_creation_input_tokens":0} |
| 58 | t10_refactor | 3 | claude_code | PASS | 61784 | {"input_tokens":3517,"output_tokens":2833,"cache_read_input_tokens":96704,"cache_creation_input_tokens":0} |
| 59 | t10_refactor | 3 | zcode | PASS | 49339 | {"inputTokens":50417,"outputTokens":2785,"cacheReadTokens":46848,"cacheWriteTokens":0} |

## Aggregation and coverage

```json
{
  "expectedCells": 60,
  "observedCells": 60,
  "complete": true,
  "allPassed": false,
  "missingCells": [],
  "duplicateCells": 0,
  "unexpectedCells": [],
  "invalidRecords": 0,
  "infraFailures": 0,
  "perLane": {
    "zcode": {
      "observed": 30,
      "pass": 29,
      "failed": 1,
      "infraFailures": 0,
      "medianWallMs": 13018,
      "nativeUsage": {
        "records": 30,
        "coverage": 1,
        "numericFields": {
          "cacheReadTokens": {
            "count": 30,
            "sum": 422400
          },
          "cacheWriteTokens": {
            "count": 30,
            "sum": 0
          },
          "inputTokens": {
            "count": 30,
            "sum": 472714
          },
          "outputTokens": {
            "count": 30,
            "sum": 23540
          }
        }
      }
    },
    "claude_code": {
      "observed": 30,
      "pass": 30,
      "failed": 0,
      "infraFailures": 0,
      "medianWallMs": 13082,
      "nativeUsage": {
        "records": 30,
        "coverage": 1,
        "numericFields": {
          "cache_creation_input_tokens": {
            "count": 30,
            "sum": 0
          },
          "cache_read_input_tokens": {
            "count": 30,
            "sum": 934400
          },
          "input_tokens": {
            "count": 30,
            "sum": 97259
          },
          "output_tokens": {
            "count": 30,
            "sum": 27300
          }
        }
      }
    }
  },
  "pairedSuccessCells": [
    {
      "task": "t1_rot13",
      "repeat": 1,
      "key": "t1_rot13\u00001",
      "zcodeWallMs": 9498,
      "claudeCodeWallMs": 6690
    },
    {
      "task": "t1_rot13",
      "repeat": 2,
      "key": "t1_rot13\u00002",
      "zcodeWallMs": 13018,
      "claudeCodeWallMs": 6491
    },
    {
      "task": "t1_rot13",
      "repeat": 3,
      "key": "t1_rot13\u00003",
      "zcodeWallMs": 7662,
      "claudeCodeWallMs": 6609
    },
    {
      "task": "t10_refactor",
      "repeat": 1,
      "key": "t10_refactor\u00001",
      "zcodeWallMs": 43496,
      "claudeCodeWallMs": 57475
    },
    {
      "task": "t10_refactor",
      "repeat": 2,
      "key": "t10_refactor\u00002",
      "zcodeWallMs": 50871,
      "claudeCodeWallMs": 96227
    },
    {
      "task": "t10_refactor",
      "repeat": 3,
      "key": "t10_refactor\u00003",
      "zcodeWallMs": 49339,
      "claudeCodeWallMs": 61784
    },
    {
      "task": "t2_fixbug",
      "repeat": 1,
      "key": "t2_fixbug\u00001",
      "zcodeWallMs": 17435,
      "claudeCodeWallMs": 14028
    },
    {
      "task": "t2_fixbug",
      "repeat": 2,
      "key": "t2_fixbug\u00002",
      "zcodeWallMs": 21366,
      "claudeCodeWallMs": 17160
    },
    {
      "task": "t2_fixbug",
      "repeat": 3,
      "key": "t2_fixbug\u00003",
      "zcodeWallMs": 16795,
      "claudeCodeWallMs": 13898
    },
    {
      "task": "t3_toposort",
      "repeat": 1,
      "key": "t3_toposort\u00001",
      "zcodeWallMs": 11745,
      "claudeCodeWallMs": 12179
    },
    {
      "task": "t3_toposort",
      "repeat": 2,
      "key": "t3_toposort\u00002",
      "zcodeWallMs": 23091,
      "claudeCodeWallMs": 13298
    },
    {
      "task": "t3_toposort",
      "repeat": 3,
      "key": "t3_toposort\u00003",
      "zcodeWallMs": 12766,
      "claudeCodeWallMs": 12776
    },
    {
      "task": "t4_multifile",
      "repeat": 1,
      "key": "t4_multifile\u00001",
      "zcodeWallMs": 23375,
      "claudeCodeWallMs": 24833
    },
    {
      "task": "t4_multifile",
      "repeat": 2,
      "key": "t4_multifile\u00002",
      "zcodeWallMs": 26674,
      "claudeCodeWallMs": 35099
    },
    {
      "task": "t4_multifile",
      "repeat": 3,
      "key": "t4_multifile\u00003",
      "zcodeWallMs": 34892,
      "claudeCodeWallMs": 20785
    },
    {
      "task": "t5_json",
      "repeat": 1,
      "key": "t5_json\u00001",
      "zcodeWallMs": 9078,
      "claudeCodeWallMs": 7301
    },
    {
      "task": "t5_json",
      "repeat": 2,
      "key": "t5_json\u00002",
      "zcodeWallMs": 8552,
      "claudeCodeWallMs": 7359
    },
    {
      "task": "t5_json",
      "repeat": 3,
      "key": "t5_json\u00003",
      "zcodeWallMs": 8230,
      "claudeCodeWallMs": 11168
    },
    {
      "task": "t6_regex",
      "repeat": 1,
      "key": "t6_regex\u00001",
      "zcodeWallMs": 12866,
      "claudeCodeWallMs": 13082
    },
    {
      "task": "t6_regex",
      "repeat": 2,
      "key": "t6_regex\u00002",
      "zcodeWallMs": 21530,
      "claudeCodeWallMs": 14524
    },
    {
      "task": "t6_regex",
      "repeat": 3,
      "key": "t6_regex\u00003",
      "zcodeWallMs": 9166,
      "claudeCodeWallMs": 11848
    },
    {
      "task": "t7_cli",
      "repeat": 1,
      "key": "t7_cli\u00001",
      "zcodeWallMs": 9841,
      "claudeCodeWallMs": 19817
    },
    {
      "task": "t7_cli",
      "repeat": 3,
      "key": "t7_cli\u00003",
      "zcodeWallMs": 18253,
      "claudeCodeWallMs": 14227
    },
    {
      "task": "t8_apiclient",
      "repeat": 1,
      "key": "t8_apiclient\u00001",
      "zcodeWallMs": 23801,
      "claudeCodeWallMs": 22496
    },
    {
      "task": "t8_apiclient",
      "repeat": 2,
      "key": "t8_apiclient\u00002",
      "zcodeWallMs": 8632,
      "claudeCodeWallMs": 12132
    },
    {
      "task": "t8_apiclient",
      "repeat": 3,
      "key": "t8_apiclient\u00003",
      "zcodeWallMs": 36479,
      "claudeCodeWallMs": 8917
    },
    {
      "task": "t9_sql",
      "repeat": 1,
      "key": "t9_sql\u00001",
      "zcodeWallMs": 6793,
      "claudeCodeWallMs": 9449
    },
    {
      "task": "t9_sql",
      "repeat": 2,
      "key": "t9_sql\u00002",
      "zcodeWallMs": 10514,
      "claudeCodeWallMs": 11241
    },
    {
      "task": "t9_sql",
      "repeat": 3,
      "key": "t9_sql\u00003",
      "zcodeWallMs": 4425,
      "claudeCodeWallMs": 9271
    }
  ],
  "pairedSuccessCount": 29,
  "medians": {
    "zcodeWallMs": 13018,
    "claudeCodeWallMs": 13082,
    "pairedSuccessCount": 29
  },
  "comparison": {
    "eligible": false,
    "canClaimWinner": false,
    "winner": null,
    "zcodeMedianWallMs": 13018,
    "claudeCodeMedianWallMs": 13082,
    "reason": "winner withheld until the complete matrix passes without infrastructure failures and has paired successes"
  },
  "tokenComparability": {
    "status": "unknown",
    "comparable": false,
    "totals": null,
    "reason": "zcode and claude_code usage fields are not validated as a common comparable measure"
  },
  "tokenTotals": null,
  "stopReason": null,
  "protectedUnchanged": true,
  "fixtureRemoved": true,
  "unexpectedChildren": 0,
  "measurementValid": true,
  "acceptancePassed": false
}
```

## Credits, free quota, and billing

Native usage fields are not assumed to have identical input/cache semantics. Missing usage is unknown, never zero.
No model or tool-call count is inferred from a successful answer. Main/lite model routing is configured explicitly; observed-model identity may be unavailable.
Actual account quota delta, charges and free-token entitlement are unverified in this runner. Do not equate token count with credits or USD.
The documented Flash campaign distinguishes official ZCode from other supported agents; matching account credentials does not prove matching campaign eligibility.
See docs/benchmarks/PAIRED-RELEASE.md for the dated official credit formula, campaign conditions and remaining evidence requirements.
