Attempt 3 failed validation. Fix the following and try again:

command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/verify-integrate.cjs"
stdout:

stderr:

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ============================
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
13 failed, 83 passed, 1 warning in 2.56s


