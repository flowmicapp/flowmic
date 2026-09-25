// The ordinary Flutter gate discovers this wrapper and executes the actual
// integration scenarios. No integration_test plugin enters the release build.
import '../integration_test/mcp_submission_scenarios.dart';

void main() { mcpSubmissionScenarios(); }
