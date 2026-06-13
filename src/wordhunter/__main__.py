import sys
from pathlib import Path

from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication
from wordhunter.webview_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Word Hunter")
    app.setOrganizationName("WordHunter")
    if hasattr(sys, "_MEIPASS"):
        icon_path = Path(sys._MEIPASS) / "wordhunter" / "assets" / "icon.ico"
    else:
        icon_path = Path(__file__).resolve().parent / "assets" / "icon.ico"
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
