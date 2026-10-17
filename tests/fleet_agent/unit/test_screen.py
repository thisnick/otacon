"""Unit tests for configure_screen's persistent phone settings."""

from unittest.mock import patch

from fleet_agent.steps.screen import configure_screen


class TestAdbAuthorizationTimeout:
    def test_disables_adb_authorization_timeout(self):
        """Android 11+ forgets "Always allow" after 7 idle days; turn that off."""
        with patch('fleet_agent.steps.screen.adb_shell') as shell:
            configure_screen('SER')
        cmds = [c.args[1] for c in shell.call_args_list]
        assert 'settings put global adb_allowed_connection_time 0' in cmds
