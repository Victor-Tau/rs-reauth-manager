"""Consent workspace extraction retains all candidates without unrelated IDs."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'protocol'))
from consent import workspace_ids

class ConsentTests(unittest.TestCase):
    def test_workspaces_json_and_streamed_index_references(self):
        self.assertEqual(workspace_ids('<script>{"workspaces":[{"id":"first"},{"id":"second"}],"unrelated":{"id":"ignored"}}</script>'), ['first', 'second'])
        payload = '[{"_1":2},"workspaces",[3,6],{"_4":5},"id","first",{"_4":7},"second"]'
        self.assertEqual(workspace_ids('<script>streamController.enqueue(' + json.dumps(payload) + ')</script>'), ['first', 'second'])

    def test_legacy_string_table_retains_all_candidates(self):
        a, b = '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'
        self.assertEqual(workspace_ids('<script>"workspaces",["id","' + a + '","id","' + b + '"]</script>'), [a, b])

    def test_import_can_prioritize_list_order_without_changing_default_extraction(self):
        text = json.dumps({'workspace_id': 'current', 'workspaces': [{'id': 'z-first'}, {'id': 'a-second'}]})
        self.assertEqual(workspace_ids(text), ['current', 'z-first', 'a-second'])
        self.assertEqual(workspace_ids(text, prefer_list=True), ['z-first', 'a-second', 'current'])
        self.assertEqual(workspace_ids('{"workspace_id":"current"}', prefer_list=True), ['current'])

    def test_import_list_priority_handles_streamed_index_references(self):
        payload = '[{"_1":2,"_3":4},"workspace_id","current","workspaces",[5,8],{"_6":7},"id","z-first",{"_6":9},"a-second"]'
        text = '<script>streamController.enqueue(' + json.dumps(payload) + ')</script>'
        self.assertEqual(workspace_ids(text, prefer_list=True), ['z-first', 'a-second', 'current'])

