Attempt 11 failed validation. Fix the following and try again:

verification failed:
command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/verify-merged.cjs"
stdout:
acceptance passed: deal-intake-and-triage
acceptance passed: spread-ratios-and-risk-grade
acceptance passed: memo-policy-and-audit-trail
acceptance passed: tiered-approval-and-sla
acceptance passed: grounded-portfolio-qa

stderr:
backend tests FAILED on the merged app
test summary info ============================
FAILED tests/test_grounded_portfolio_qa.py::test_answer_is_grounded_in_live_deal_records
FAILED tests/test_spread_ratios_and_risk_grade.py::test_attaching_the_pack_reports_completeness
FAILED tests/test_spread_ratios_and_risk_grade.py::test_partial_pack_reports_what_is_missing
FAILED tests/test_spread_ratios_and_risk_grade.py::test_spread_run_cites_every_row_and_omits_the_illegible_line
FAILED tests/test_spread_ratios_and_risk_grade.py::test_nothing_reaches_the_template_before_acceptance
FAILED tests/test_spread_ratios_and_risk_grade.py::test_accepting_the_spread_records_the_reviewer_and_computes_everything
FAILED tests/test_spread_ratios_and_risk_grade.py::test_rejecting_needs_a_written_reason_and_writes_nothing
FAILED tests/test_spread_ratios_and_risk_grade.py::test_an_edited_figure_must_still_have_a_cited_source
FAILED tests/test_spread_ratios_and_risk_grade.py::test_editing_a_cited_figure_is_accepted_and_changes_the_grade
FAILED tests/test_spread_ratios_and_risk_grade.py::test_ratios_show_their_arithmetic_and_rounding
FAILED tests/test_spread_ratios_and_risk_grade.py::test_a_zero_denominator_is_undefined_not_an_error
FAILED tests/test_spread_ratios_and_risk_grade.py::test_risk_grade_prints_the_band_it_struck
FAILED tests/test_spread_ratios_and_risk_grade.py::test_every_step_leaves_an_audit_trail
FAILED tests/test_spread_ratios_and_risk_grade.py::test_dossier_assembles_the_whole_screen
14 failed, 82 passed, 1 warning in 1.96s


