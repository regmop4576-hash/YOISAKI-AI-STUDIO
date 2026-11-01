# Face Fix detector weights (YOISAKI ENGINE v1.8.1)

Both files are small, CPU-only OpenCV models, bundled unmodified. They are loaded
lazily on the first detection request; neither is loaded at engine start.

| File | SHA-256 | Source | License |
|---|---|---|---|
| `lbpcascade_animeface.xml` | `9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30` | https://github.com/nagadomi/lbpcascade_animeface (commit on `master`, file `lbpcascade_animeface.xml`) | MIT, Copyright (C) 2011 nagadomi. The full notice is embedded at the top of the XML file itself. |
| `face_detection_yunet_2023mar.onnx` | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet | MIT, Copyright (c) 2020 Shiqi Yu. Notice reproduced below. |

Runtime: `opencv-python-headless==4.11.0.86` (Apache-2.0), already pinned by the engine for ControlNet preprocessing.
No Ultralytics/AGPL code or weights are used.

---

MIT License

Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
