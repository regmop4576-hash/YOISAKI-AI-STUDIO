import pytest
@pytest.fixture(autouse=True)
def isolated_result_disk(tmp_path,monkeypatch):
    monkeypatch.setenv('YOISAKI_RESULTS_DIR',str(tmp_path/'engine-results'))
