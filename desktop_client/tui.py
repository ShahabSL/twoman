from __future__ import annotations

from pathlib import Path

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.css.query import NoMatches
from textual.reactive import reactive
from textual.screen import ModalScreen
from textual.timer import Timer
from textual.widgets import Button, Checkbox, Footer, Header, Input, Select, Static

from desktop_client.controller import DesktopController
from desktop_client.models import ClientProfile, SharedSocksProxy


APP_CSS = """
Screen {
    background: black;
    color: white;
}

#body {
    padding: 1 2;
}

.card {
    border: solid white;
    padding: 1 1;
    margin-bottom: 1;
    height: auto;
}

.section-title {
    text-style: bold;
    margin-bottom: 1;
}

.toolbar {
    height: auto;
    margin-top: 1;
}

Button {
    margin-right: 1;
    border: solid white;
    background: black;
    color: white;
}

Button.-active {
    background: white;
    color: black;
}

#status-banner {
    border: heavy white;
    padding: 1 2;
    height: auto;
    margin-bottom: 1;
}

#connect-button {
    min-width: 18;
}

#profiles-select, #shares-select {
    margin-bottom: 1;
}

#log-output {
    height: 12;
    overflow-y: auto;
    background: black;
    color: white;
    border: solid white;
    padding: 1;
}

.detail {
    margin-top: 1;
    color: white;
}

ModalScreen {
    align: center middle;
}

.dialog {
    width: 80;
    height: auto;
    background: black;
    color: white;
    border: heavy white;
    padding: 1 2;
}

.dialog Input {
    margin-bottom: 1;
}

.dialog Checkbox {
    margin-bottom: 1;
}
"""


class MessageScreen(ModalScreen[None]):
    def __init__(self, title: str, message: str) -> None:
        super().__init__()
        self.title = title
        self.message = message

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Static(self.title, classes="section-title")
            yield Static(self.message)
            yield Button("Close", id="close", variant="primary")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "close":
            self.dismiss(None)


class ImportProfileScreen(ModalScreen[ClientProfile | None]):
    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Static("Import profile", classes="section-title")
            yield Input(placeholder="Paste twoman://profile... or encoded text", id="import-text")
            with Horizontal(classes="toolbar"):
                yield Button("Import", id="import-save", variant="primary")
                yield Button("Cancel", id="import-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "import-cancel":
            self.dismiss(None)
            return
        if event.button.id != "import-save":
            return
        try:
            profile = ClientProfile.from_share_text(self.query_one("#import-text", Input).value)
        except Exception as error:  # pragma: no cover - exercised in TUI
            self.notify(str(error), severity="error")
            return
        self.dismiss(profile)


class ExportProfileScreen(ModalScreen[None]):
    def __init__(self, share_text: str) -> None:
        super().__init__()
        self.share_text = share_text

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Static("Share profile", classes="section-title")
            yield Input(value=self.share_text, id="export-text")
            with Horizontal(classes="toolbar"):
                yield Button("Close", id="export-close", variant="primary")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "export-close":
            self.dismiss(None)


class ProfileEditorScreen(ModalScreen[ClientProfile | None]):
    def __init__(self, existing: ClientProfile | None = None) -> None:
        super().__init__()
        self.existing = existing

    def compose(self) -> ComposeResult:
        profile = self.existing or ClientProfile(name="", broker_base_url="", client_token="")
        with Vertical(classes="dialog"):
            yield Static("Profile", classes="section-title")
            yield Input(value=profile.name, placeholder="Name", id="profile-name")
            yield Input(value=profile.broker_base_url, placeholder="Broker URL", id="profile-url")
            yield Input(value=profile.client_token, placeholder="Client token", password=True, id="profile-token")
            yield Input(value=profile.target_agent_peer_label, placeholder="Target agent label (optional)", id="profile-target-agent")
            yield Input(value=str(profile.http_port), placeholder="HTTP port", id="profile-http-port", type="number")
            yield Input(value=str(profile.socks_port), placeholder="SOCKS port", id="profile-socks-port", type="number")
            yield Checkbox("Verify TLS", value=profile.verify_tls, id="profile-verify-tls")
            yield Checkbox("HTTP/2 control", value=profile.http2_ctl, id="profile-http2-ctl")
            yield Checkbox("HTTP/2 data", value=profile.http2_data, id="profile-http2-data")
            with Horizontal(classes="toolbar"):
                yield Button("Save", id="profile-save", variant="primary")
                yield Button("Cancel", id="profile-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "profile-cancel":
            self.dismiss(None)
            return
        if event.button.id != "profile-save":
            return
        existing_id = self.existing.id if self.existing is not None else None
        profile = ClientProfile(
            id=existing_id or ClientProfile(name="", broker_base_url="", client_token="").id,
            name=self.query_one("#profile-name", Input).value.strip(),
            broker_base_url=self.query_one("#profile-url", Input).value.strip(),
            client_token=self.query_one("#profile-token", Input).value.strip(),
            target_agent_peer_label=self.query_one("#profile-target-agent", Input).value.strip(),
            verify_tls=self.query_one("#profile-verify-tls", Checkbox).value,
            http2_ctl=self.query_one("#profile-http2-ctl", Checkbox).value,
            http2_data=self.query_one("#profile-http2-data", Checkbox).value,
            http_port=int(self.query_one("#profile-http-port", Input).value or 28167),
            socks_port=int(self.query_one("#profile-socks-port", Input).value or 21167),
        )
        try:
            profile.validate()
        except Exception as error:  # pragma: no cover - exercised in TUI
            self.notify(str(error), severity="error")
            return
        self.dismiss(profile)


class ShareEditorScreen(ModalScreen[SharedSocksProxy | None]):
    def __init__(self, existing: SharedSocksProxy | None) -> None:
        super().__init__()
        self.existing = existing

    def compose(self) -> ComposeResult:
        share = self.existing or SharedSocksProxy(name="New share", listen_port=31167, target_port=21167)
        with Vertical(classes="dialog"):
            yield Static("Shared SOCKS", classes="section-title")
            yield Input(value=share.name, placeholder="Name", id="share-name")
            yield Input(value=share.listen_host, placeholder="Listen host", id="share-listen-host")
            yield Input(value=str(share.listen_port), placeholder="Listen port", id="share-listen-port", type="number")
            yield Input(value=share.username, placeholder="Username", id="share-username")
            yield Input(value=share.password, placeholder="Password", id="share-password", password=True)
            yield Input(value=share.target_host, placeholder="Target host", id="share-target-host")
            yield Input(value=str(share.target_port), placeholder="Target port", id="share-target-port", type="number")
            with Horizontal(classes="toolbar"):
                yield Button("Generate creds", id="share-generate")
                yield Button("Save", id="share-save", variant="primary")
                yield Button("Cancel", id="share-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "share-cancel":
            self.dismiss(None)
            return
        if event.button.id == "share-generate":
            generated = SharedSocksProxy(name="tmp", listen_port=1, target_port=1)
            self.query_one("#share-username", Input).value = generated.username
            self.query_one("#share-password", Input).value = generated.password
            return
        if event.button.id != "share-save":
            return
        existing_id = self.existing.id if self.existing is not None else None
        share = SharedSocksProxy(
            id=existing_id or SharedSocksProxy(name="tmp", listen_port=1, target_port=1).id,
            name=self.query_one("#share-name", Input).value.strip(),
            listen_host=self.query_one("#share-listen-host", Input).value.strip() or "0.0.0.0",
            listen_port=int(self.query_one("#share-listen-port", Input).value or 31167),
            username=self.query_one("#share-username", Input).value.strip(),
            password=self.query_one("#share-password", Input).value.strip(),
            target_host=self.query_one("#share-target-host", Input).value.strip() or "127.0.0.1",
            target_port=int(self.query_one("#share-target-port", Input).value or 21167),
        )
        try:
            share.validate()
        except Exception as error:  # pragma: no cover - exercised in TUI
            self.notify(str(error), severity="error")
            return
        self.dismiss(share)


class DesktopClientApp(App):
    TITLE = "Twoman Desktop"
    SUB_TITLE = "Proxy manager"
    CSS = APP_CSS
    BINDINGS = [("q", "quit", "Quit"), ("r", "refresh", "Refresh")]

    selected_profile_id = reactive[str | None](None)
    selected_share_id = reactive[str | None](None)

    def __init__(self, controller: DesktopController | None = None) -> None:
        super().__init__()
        self.controller = controller or DesktopController()
        self._refresh_timer: Timer | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="body"):
            with Vertical(id="status-banner"):
                yield Static("Disconnected", id="status-text")
                yield Static("Add a profile to connect.", id="status-detail")
                yield Button("Connect", id="connect-button", variant="primary")
            with Vertical(classes="card"):
                yield Static("Profiles", classes="section-title")
                yield Select[str | None]([], allow_blank=True, prompt="Saved profiles", id="profiles-select")
                with Horizontal(classes="toolbar"):
                    yield Button("Add", id="profile-add")
                    yield Button("Edit", id="profile-edit")
                    yield Button("Delete", id="profile-delete")
                    yield Button("Share", id="profile-share")
                    yield Button("Import", id="profile-import")
                yield Static("", id="profile-detail", classes="detail")
            with Vertical(classes="card"):
                yield Static("Shared SOCKS", classes="section-title")
                yield Select[str | None]([], allow_blank=True, prompt="Shared proxies", id="shares-select")
                with Horizontal(classes="toolbar"):
                    yield Button("Add", id="share-add")
                    yield Button("Edit", id="share-edit")
                    yield Button("Delete", id="share-delete")
                    yield Button("Start", id="share-start")
                    yield Button("Stop", id="share-stop")
                yield Static("", id="share-detail", classes="detail")
            with Vertical(classes="card"):
                yield Static("Logs", classes="section-title")
                yield Static("", id="log-output")
        yield Footer()

    def on_mount(self) -> None:
        self.refresh_all()
        self._refresh_timer = self.set_interval(1.0, self.refresh_all)

    def on_unmount(self) -> None:
        # Stop the periodic refresh before Textual tears down Select internals.
        if self._refresh_timer is not None:
            self._refresh_timer.stop()
            self._refresh_timer = None

    def action_refresh(self) -> None:
        self.refresh_all()

    def refresh_all(self) -> None:
        profiles = self.controller.list_profiles()
        shares = self.controller.list_shares()
        selection = self.controller.selection()
        if self.selected_profile_id is None:
            self.selected_profile_id = selection.profile_id
        if self.selected_share_id is None and shares:
            self.selected_share_id = shares[0].id

        try:
            profile_select = self.query_one("#profiles-select", Select)
            share_select = self.query_one("#shares-select", Select)

            profile_select.set_options([(profile.name, profile.id) for profile in profiles])
            if self.selected_profile_id and any(profile.id == self.selected_profile_id for profile in profiles):
                profile_select.value = self.selected_profile_id
            else:
                profile_select.clear()
                self.selected_profile_id = None

            share_select.set_options([(share.name, share.id) for share in shares])
            if self.selected_share_id and any(share.id == self.selected_share_id for share in shares):
                share_select.value = self.selected_share_id
            else:
                share_select.clear()
                self.selected_share_id = None
        except NoMatches:
            # The refresh timer can overlap shutdown while Select internals unmount.
            return

        try:
            self._render_status()
            self._render_profile_details()
            self._render_share_details()
            self._render_logs()
        except NoMatches:
            # Screen transitions can briefly remove widgets after the Selects
            # were still present, especially under slower CI timing.
            return

    def _render_status(self) -> None:
        status = self.controller.helper_status()
        button = self.query_one("#connect-button", Button)
        if status.running:
            self.query_one("#status-text", Static).update(f"Connected · {status.profile_name}")
            self.query_one("#status-detail", Static).update(
                f"HTTP {status.http_port} · SOCKS {status.socks_port} · PID {status.pid}"
            )
            button.label = "Disconnect"
            button.add_class("-active")
        else:
            self.query_one("#status-text", Static).update("Disconnected")
            self.query_one("#status-detail", Static).update(
                status.message.strip() or "Select a profile and connect."
            )
            button.label = "Connect"
            button.remove_class("-active")

    def _render_profile_details(self) -> None:
        profile = self.controller.get_profile(self.selected_profile_id)
        if profile is None:
            self.query_one("#profile-detail", Static).update("No profile selected.")
            return
        detail = "\n".join(
            [
                profile.broker_base_url,
                f"SOCKS {profile.socks_port} · HTTP {profile.http_port}",
                f"TLS {'on' if profile.verify_tls else 'off'} · H2 ctl {'on' if profile.http2_ctl else 'off'} · H2 data {'on' if profile.http2_data else 'off'}",
            ]
        )
        self.query_one("#profile-detail", Static).update(detail)

    def _render_share_details(self) -> None:
        share = self.controller.get_share(self.selected_share_id)
        if share is None:
            self.query_one("#share-detail", Static).update("No shared proxy selected.")
            return
        share_status = self.controller.share_status(share.id)
        state = "running" if share_status.running else "stopped"
        addresses = ", ".join(share_status.addresses)
        detail = "\n".join(
            [
                f"{share.username} / {share.password}",
                f"{share.listen_host}:{share.listen_port} → {share.target_host}:{share.target_port}",
                f"{state} · {addresses}",
            ]
        )
        self.query_one("#share-detail", Static).update(detail)

    def _render_logs(self) -> None:
        status = self.controller.helper_status()
        log_lines: list[str] = []
        if status.log_path:
            helper_path = Path(status.log_path)
            if helper_path.exists():
                log_lines.extend(helper_path.read_text(encoding="utf-8", errors="replace").splitlines()[-10:])
        share = self.controller.get_share(self.selected_share_id)
        if share is not None:
            share_status = self.controller.share_status(share.id)
            share_path = Path(share_status.log_path)
            if share_path.exists():
                share_lines = share_path.read_text(encoding="utf-8", errors="replace").splitlines()[-10:]
                if share_lines:
                    log_lines.extend(["", "share:"] + share_lines)
        self.query_one("#log-output", Static).update("\n".join(log_lines[-20:]) or "No log output yet.")

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "profiles-select":
            self.selected_profile_id = event.value if event.value is not Select.BLANK else None
            self.controller.set_selected_profile(self.selected_profile_id)
            self._render_profile_details()
            return
        if event.select.id == "shares-select":
            self.selected_share_id = event.value if event.value is not Select.BLANK else None
            self._render_share_details()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id
        if button_id == "connect-button":
            if self.controller.helper_status().running:
                self.controller.disconnect()
            else:
                if not self.selected_profile_id:
                    self.notify("Add a profile first.", severity="warning")
                else:
                    try:
                        self.controller.connect(self.selected_profile_id)
                    except Exception as error:
                        self.notify(str(error), severity="error")
            self.refresh_all()
            return

        if button_id == "profile-add":
            self.push_screen(ProfileEditorScreen(), self._on_profile_saved)
            return
        if button_id == "profile-edit":
            profile = self.controller.get_profile(self.selected_profile_id)
            if profile:
                self.push_screen(ProfileEditorScreen(profile), self._on_profile_saved)
            return
        if button_id == "profile-delete":
            if self.selected_profile_id:
                self.controller.delete_profile(self.selected_profile_id)
                self.selected_profile_id = self.controller.selection().profile_id
                self.refresh_all()
            return
        if button_id == "profile-share":
            if self.selected_profile_id:
                self.push_screen(ExportProfileScreen(self.controller.export_profile_text(self.selected_profile_id)))
            return
        if button_id == "profile-import":
            self.push_screen(ImportProfileScreen(), self._on_profile_imported)
            return

        if button_id == "share-add":
            selected_profile = self.controller.get_profile(self.selected_profile_id)
            default_target = selected_profile.socks_port if selected_profile else 21167
            self.push_screen(ShareEditorScreen(self.controller.new_share_template(default_target)), self._on_share_saved)
            return
        if button_id == "share-edit":
            share = self.controller.get_share(self.selected_share_id)
            if share:
                self.push_screen(ShareEditorScreen(share), self._on_share_saved)
            return
        if button_id == "share-delete":
            if self.selected_share_id:
                self.controller.delete_share(self.selected_share_id)
                shares = self.controller.list_shares()
                self.selected_share_id = shares[0].id if shares else None
                self.refresh_all()
            return
        if button_id == "share-start":
            if self.selected_share_id:
                try:
                    self.controller.start_share(self.selected_share_id)
                except Exception as error:
                    self.notify(str(error), severity="error")
                self.refresh_all()
            return
        if button_id == "share-stop":
            if self.selected_share_id:
                self.controller.stop_share(self.selected_share_id)
                self.refresh_all()
            return

    def _on_profile_saved(self, profile: ClientProfile | None) -> None:
        if profile is None:
            return
        self.controller.save_profile(profile)
        self.selected_profile_id = profile.id
        self.refresh_all()

    def _on_profile_imported(self, profile: ClientProfile | None) -> None:
        if profile is None:
            return
        saved = self.controller.save_profile(profile)
        self.selected_profile_id = saved.id
        self.refresh_all()

    def _on_share_saved(self, share: SharedSocksProxy | None) -> None:
        if share is None:
            return
        self.controller.save_share(share)
        self.selected_share_id = share.id
        self.refresh_all()
