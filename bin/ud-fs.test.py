import datetime
from importlib.machinery import SourceFileLoader
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from zoneinfo import ZoneInfo

PLUGIN = Path(__file__).with_name("ud-fs").resolve()
spec = importlib.util.spec_from_loader("publisher", SourceFileLoader("publisher", str(PLUGIN)))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.file = Path(self.directory.name) / "20261012-104530.png"
        self.file.write_bytes(b"image")
        self.env = dict(os.environ)
        for name in ["UD_PLUGIN_PATH", "PUB_BASE_URL", "PUB_BUCKET", "UD_FS_BASE_URL", "UD_FS_BUCKET"]:
            self.env.pop(name, None)
        for name, child in [("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_CONFIG_HOME", "config")]:
            self.env[name] = str(Path(self.directory.name) / child)
        plugins = Path(self.env["XDG_DATA_HOME"]) / "ud/plugins"
        plugins.mkdir(parents=True)
        (plugins / "ud-fs").symlink_to(PLUGIN)
    def tearDown(self): self.directory.cleanup()
    def command(self, *args):
        return subprocess.run([os.environ.get("UD_FS_TEST_UD", "ud"), *args],
                              env=self.env, text=True, capture_output=True)
    def dry_run(self, slug, *flags):
        result = self.command("fs", "publish", str(self.file), slug, "--dry-run", *flags)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()
    def test_screenshot_date_and_markdown_url(self):
        _, key, url = publisher.plan(self.file, "trade-modal")
        self.assertEqual(key, "26/261012-trade-modal.png")
        self.assertEqual(url, "https://uniquedivine.com/f/26/261012-trade-modal.png")
    def test_explicit_date_and_preview_origin(self):
        _, key, url = publisher.plan(self.file, "report", "2026-09-01", "https://uniquedivine-site.web.app")
        self.assertEqual(key, "26/260901-report.png")
        self.assertTrue(url.startswith("https://uniquedivine-site.web.app/f/"))
    def test_invalid_inputs(self):
        for slug in ["", "../secret", "bad space", "Bad", "bad--slug", "x" * 81,
                     "report.", "report..pdf", "report.p/ng", "report.p\\ng"]:
            with self.assertRaises(ValueError): publisher.plan(self.file, slug)
        for date in ["2026-02-30", "26-10-12", "2026-1-1"]:
            with self.assertRaises(ValueError): publisher.plan(self.file, "ok", date)
        for base in ["http://example.com", "https://example.com/f", "https://user@example.com", "https://example.com?x=1"]:
            with self.assertRaises(ValueError): publisher.plan(self.file, "ok", base_url=base)
    def test_size_boundary(self):
        with self.file.open("wb") as file: file.truncate(publisher.MAX_BYTES)
        publisher.plan(self.file, "large")
        with self.file.open("wb") as file: file.truncate(publisher.MAX_BYTES + 1)
        with self.assertRaises(ValueError): publisher.plan(self.file, "large")

    def test_explicit_extension_overrides_source(self):
        for slug, expected in [("trade-modal.webp", "26/261012-trade-modal.webp"),
                               ("trade-modal.PNG", "26/261012-trade-modal.png"),
                               ("source.tar.gz", "26/261012-source.tar.gz")]:
            self.assertEqual(publisher.plan(self.file, slug)[1], expected)
        self.assertEqual(self.dry_run("trade-modal.webp", "--md"),
                         '<img src="https://uniquedivine.com/f/26/261012-trade-modal.webp" alt="trade modal" />')
        self.assertEqual(self.dry_run("report.pdf", "--md"),
                         '[report](https://uniquedivine.com/f/26/261012-report.pdf)')

    def test_outputs_and_date_override_through_ud(self):
        self.assertEqual(self.dry_run("trade-modal"),
                         "https://uniquedivine.com/f/26/261012-trade-modal.png")
        self.assertEqual(self.dry_run("trade-modal", "--md", "--no-clipboard", "--date", "2026-09-01"),
                         '<img src="https://uniquedivine.com/f/26/260901-trade-modal.png" alt="trade modal" />')
        invalid = self.command("fs", "publish", str(self.file), "../bad.png", "--dry-run")
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual(invalid.stdout, "")

    def test_bangkok_date_and_extensionless_file(self):
        file = Path(self.directory.name) / "report"
        file.write_bytes(b"file")
        before = datetime.datetime.now(ZoneInfo("Asia/Bangkok")).date()
        key = publisher.plan(file, "report")[1]
        after = datetime.datetime.now(ZoneInfo("Asia/Bangkok")).date()
        self.assertIn(key, [day.strftime("%y/%y%m%d") + "-report" for day in [before, after]])
        self.assertTrue(publisher.plan(file, "report.pdf")[1].endswith("-report.pdf"))

    def test_plugin_discovery_and_help(self):
        info = self.command("plugin", "info", "fs")
        self.assertEqual(info.returncode, 0, info.stderr)
        metadata = json.loads(info.stdout)
        self.assertEqual(metadata["name"], "fs")
        self.assertEqual(metadata["apiVersion"], 1)
        root = self.command("--help")
        self.assertEqual(root.returncode, 0, root.stderr)
        self.assertIn(metadata["description"], root.stdout)
        help_result = self.command("fs", "--help")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("usage: ud fs", help_result.stdout)
        self.assertIn("publish", help_result.stdout)
        self.assertIn("ls", help_result.stdout)
        upload_help = self.command("fs", "publish", "--help")
        self.assertEqual(upload_help.returncode, 0, upload_help.stderr)
        self.assertIn("--md", upload_help.stdout)
        list_help = self.command("fs", "ls", "--help")
        self.assertEqual(list_help.returncode, 0, list_help.stderr)
        self.assertIn("--urls", list_help.stdout)

    def test_configuration_precedence_and_legacy_fallback(self):
        root = Path(self.env["XDG_CONFIG_HOME"])
        legacy = root / "pub/config.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps({"base_url": "https://legacy.example.com"}))
        self.assertTrue(self.dry_run("report").startswith("https://legacy.example.com/"))
        config = root / "ud/fs/config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"base_url": "https://configured.example.com"}))
        self.assertTrue(self.dry_run("report").startswith("https://configured.example.com/"))
        self.env["PUB_BASE_URL"] = "https://old-env.example.com"
        self.assertTrue(self.dry_run("report").startswith("https://old-env.example.com/"))
        self.env["UD_FS_BASE_URL"] = "https://new-env.example.com"
        self.assertTrue(self.dry_run("report").startswith("https://new-env.example.com/"))

    def test_nested_names_and_year_boundary(self):
        self.assertEqual(publisher.plan(self.file, "ui/social/twitter.svg")[1],
                         "26/ui/social/261012-twitter.svg")
        self.assertEqual(self.dry_run("ui/trade-modal.png", "--md"),
                         '<img src="https://uniquedivine.com/f/26/ui/261012-trade-modal.png" alt="trade modal" />')
        self.assertEqual(publisher.plan(self.file, "ui/icon", "2027-01-01")[1],
                         "27/ui/270101-icon.png")
        for slug in ["/ui/icon", "ui//icon", "ui/", "ui/../icon", "UI/icon",
                     "ui\\icon", "ui/./icon", "x" * 81 + "/icon"]:
            with self.assertRaises(ValueError):
                publisher.plan(self.file, slug)

    def test_directory_selection(self):
        self.assertEqual(publisher.directory_prefix(""), "")
        self.assertEqual(publisher.directory_prefix("26/ui"), "26/ui/")
        self.assertEqual(publisher.directory_prefix("26/ui/"), "26/ui/")
        for directory in ["/", "/26", "../26", "26//ui", "26/ui//",
                          "26/../ui", "26/%2f", "26\\ui", "26/*"]:
            with self.assertRaises(ValueError):
                publisher.directory_prefix(directory)

    def test_listing_metadata_and_formats(self):
        metadata = {"name": "26/ui/261013-twitter.svg", "size": "54",
                    "contentType": "application/octet-stream", "generation": "123"}
        record = publisher.normalize_object(metadata, "https://uniquedivine.com")
        expected = {"key": metadata["name"],
                    "url": "https://uniquedivine.com/f/26/ui/261013-twitter.svg",
                    "size": 54, "contentType": "application/octet-stream"}
        self.assertEqual(record, expected)
        self.assertEqual(publisher.listing_output([record]),
                         'files[1]{url,size,contentType}:\n'
                         '  "https://uniquedivine.com/f/26/ui/261013-twitter.svg",54,application/octet-stream')
        self.assertEqual(json.loads(publisher.listing_output([record], "json")),
                         {"files": [{k: expected[k] for k in publisher.LIST_FIELDS}]})
        self.assertEqual(publisher.listing_output([record], "urls"), expected["url"])
        self.assertEqual(publisher.listing_output([record], "paths"), expected["key"])
        self.assertEqual(publisher.listing_output([]), "files: []")
        self.assertEqual(json.loads(publisher.listing_output([], "json")), {"files": []})
        self.assertEqual(publisher.listing_output([], "urls"), "")
        self.assertIsNone(publisher.normalize_object({"name": "26/ui/", "size": "0"},
                                                    "https://uniquedivine.com"))
        metadata.pop("contentType")
        self.assertEqual(publisher.normalize_object(metadata, "https://uniquedivine.com")["contentType"],
                         "application/octet-stream")
        metadata["size"] = "invalid"
        with self.assertRaises(ValueError):
            publisher.normalize_object(metadata, "https://uniquedivine.com")

    def test_time_filters(self):
        for value, expected in [("26", "26"), ("2609", "2609"),
                                ("26-09", "2609"), ("261014", "261014"),
                                ("26-10-14", "261014"), ("24-02-29", "240229")]:
            self.assertEqual(publisher.time_filter(value), expected)
        for value in ["", "2", "2026-10-14", "26-1", "2613", "2600",
                      "26-02-29", "261032", "26/09", "26--09", " 26"]:
            with self.assertRaises(ValueError): publisher.time_filter(value)

    def test_publication_dates_across_layouts(self):
        for key in ["26/ui/social/261014-twitter.svg", "26/10-14-twitter.svg",
                    "26-10-14-twitter.svg"]:
            self.assertEqual(publisher.publication_date(key), "261014")
        for key in ["26/ui/twitter.svg", "27/ui/261014-icon.svg",
                    "26/260229-bad.png", "26/02-30-bad.png", "notes.pdf"]:
            self.assertIsNone(publisher.publication_date(key))

    def test_listing_scope_and_bangkok_boundaries(self):
        for instant, expected in [("2026-12-31T17:00:00+00:00", "2701"),
                                  ("2026-09-30T16:59:59+00:00", "2609"),
                                  ("2026-09-30T17:00:00+00:00", "2610")]:
            self.assertEqual(publisher.listing_selection(
                now=datetime.datetime.fromisoformat(instant)), ("", expected, True))
        self.assertEqual(publisher.listing_selection("26/ui/"), ("26/ui/", None, False))
        self.assertEqual(publisher.listing_selection(all_dates=True), ("", None, False))
        self.assertEqual(publisher.listing_selection("26/ui", "26-09"),
                         ("26/ui/", "2609", False))
        with self.assertRaises(ValueError):
            publisher.listing_selection(selected_time="26", all_dates=True)
        keys = ["26/ui/260901-a.png", "26/ui/261014-b.png", "26/09-01-c.png",
                "26-09-01-d.png", "26/ui/undated.png", "26/uix/260901-e.png"]
        records = [{"key": key} for key in keys]
        self.assertEqual([r["key"] for r in publisher.filter_listing(
            records, "26/ui/", "2609")], keys[:1])
        self.assertEqual(len(publisher.filter_listing(records, "", "2609")), 4)
        self.assertEqual(len(publisher.filter_listing(records, "", None)), 6)
        self.assertEqual(len(publisher.filter_listing(records, "26/ui/", None)), 3)

    def test_toon_string_quoting_and_control_escapes(self):
        for value in ["plain", "image/png", "26/ui/icon.png", "internal spaces", "café"]:
            self.assertEqual(publisher.toon_string(value), value)
        for value in ["", "42", "05", "false", "https://example.com", "x,y",
                      "[x]", "-name", "#name", " leading", "trailing ",
                      'a"b', "a\\b", "a\nb", "a\tb", "a\x01b", "a\bb", "a\fb"]:
            encoded = publisher.toon_string(value)
            self.assertEqual(json.loads(encoded), value)
        self.assertEqual(publisher.toon_string("a\bb"), '"a\\u0008b"')
        self.assertEqual(publisher.toon_string("a\fb"), '"a\\u000cb"')

    def test_command_errors_do_not_authenticate_or_print_data(self):
        old = self.command("fs", str(self.file), "name", "--dry-run")
        self.assertNotEqual(old.returncode, 0)
        self.assertIn("ud fs publish FILE NAME", old.stderr)
        bare = self.command("fs")
        self.assertEqual(bare.returncode, 0, bare.stderr)
        self.assertIn("publish", bare.stdout)
        for args in [("ls", "--json", "--urls"), ("ls", "../26"),
                     ("publish",), ("unknown",), ("ls", "--time", "261332"),
                     ("ls", "--time", "26", "--all"), ("ls", "--al")]:
            result = self.command("fs", *args)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

if __name__ == "__main__": unittest.main()
