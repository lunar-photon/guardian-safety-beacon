package com.lunarphoton.stratus;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.graphics.YuvImage;
import android.hardware.Camera;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Size;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public class CameraCapture {

    public interface Callback {
        void onCaptured(byte[] jpegBytes);
        void onError(String error);
    }

    public static void takePhoto(Context context, int facingCamera1, Callback callback) {
        // 1. Permission check
        if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            if (callback != null) callback.onError("Camera permission denied on phone");
            return;
        }

        // Try Camera2 first
        tryCamera2(context, facingCamera1, 0, new Callback() {
            @Override
            public void onCaptured(byte[] jpegBytes) {
                if (callback != null) callback.onCaptured(jpegBytes);
            }

            @Override
            public void onError(String error) {
                // Allow hardware brief 350ms release buffer before Camera1 fallback
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    tryCamera1(facingCamera1, callback);
                }, 350);
            }
        });
    }

    // -------------------------------------------------------------
    // Camera2 implementation (modern, background-safe, ImageReader)
    // -------------------------------------------------------------
    private static void tryCamera2(Context context, int facingCamera1, int retryCount, Callback callback) {
        HandlerThread thread = new HandlerThread("Camera2Bg");
        thread.start();
        Handler bgHandler = new Handler(thread.getLooper());

        int targetFacing = (facingCamera1 == Camera.CameraInfo.CAMERA_FACING_FRONT)
                ? CameraCharacteristics.LENS_FACING_FRONT
                : CameraCharacteristics.LENS_FACING_BACK;

        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            thread.quitSafely();
            if (callback != null) callback.onError("CameraManager unavailable");
            return;
        }

        try {
            String selectedId = null;
            CameraCharacteristics selectedChars = null;
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics chars = manager.getCameraCharacteristics(id);
                Integer f = chars.get(CameraCharacteristics.LENS_FACING);
                if (f != null && f == targetFacing) {
                    selectedId = id;
                    selectedChars = chars;
                    break;
                }
            }
            if (selectedId == null && manager.getCameraIdList().length > 0) {
                selectedId = manager.getCameraIdList()[0];
                selectedChars = manager.getCameraCharacteristics(selectedId);
            }
            if (selectedId == null || selectedChars == null) {
                thread.quitSafely();
                if (callback != null) callback.onError("No camera found");
                return;
            }

            final String cameraId = selectedId;

            // Dynamically select a supported JPEG resolution from camera characteristics
            int chosenWidth = 1280;
            int chosenHeight = 720;
            try {
                StreamConfigurationMap map = selectedChars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map != null) {
                    Size[] sizes = map.getOutputSizes(ImageFormat.JPEG);
                    if (sizes != null && sizes.length > 0) {
                        Size best = null;
                        for (Size s : sizes) {
                            if (s.getWidth() <= 1280 && s.getHeight() <= 720 && s.getWidth() >= 640 && s.getHeight() >= 480) {
                                if (best == null || (s.getWidth() * s.getHeight() > best.getWidth() * best.getHeight())) {
                                    best = s;
                                }
                            }
                        }
                        if (best == null) {
                            for (Size s : sizes) {
                                if (s.getWidth() <= 1920 && s.getHeight() <= 1080) {
                                    best = s;
                                    break;
                                }
                            }
                        }
                        if (best == null) best = sizes[0];
                        chosenWidth = best.getWidth();
                        chosenHeight = best.getHeight();
                    }
                }
            } catch (Exception ignored) {}

            final ImageReader reader = ImageReader.newInstance(chosenWidth, chosenHeight, ImageFormat.JPEG, 2);
            final AtomicBoolean finished = new AtomicBoolean(false);
            final CameraDevice[] cameraDeviceHolder = new CameraDevice[1];
            final CameraCaptureSession[] sessionHolder = new CameraCaptureSession[1];

            // Comprehensive cleanup routine to release all camera hardware immediately
            Runnable cleanup = () -> {
                try {
                    if (sessionHolder[0] != null) {
                        try { sessionHolder[0].stopRepeating(); } catch (Exception ignored) {}
                        try { sessionHolder[0].abortCaptures(); } catch (Exception ignored) {}
                        sessionHolder[0].close();
                        sessionHolder[0] = null;
                    }
                } catch (Exception ignored) {}
                try {
                    if (cameraDeviceHolder[0] != null) {
                        cameraDeviceHolder[0].close();
                        cameraDeviceHolder[0] = null;
                    }
                } catch (Exception ignored) {}
                try {
                    reader.close();
                } catch (Exception ignored) {}
                try {
                    thread.quitSafely();
                } catch (Exception ignored) {}
            };

            reader.setOnImageAvailableListener(r -> {
                if (finished.compareAndSet(false, true)) {
                    byte[] bytes = null;
                    try (Image img = r.acquireLatestImage()) {
                        if (img != null) {
                            ByteBuffer buffer = img.getPlanes()[0].getBuffer();
                            bytes = new byte[buffer.remaining()];
                            buffer.get(bytes);
                        }
                    } catch (Exception ignored) {}

                    // Immediately close and release camera device and session so it is no longer in use
                    cleanup.run();

                    if (bytes != null && bytes.length > 0) {
                        if (callback != null) callback.onCaptured(bytes);
                    } else {
                        if (callback != null) callback.onError("Image buffer empty");
                    }
                }
            }, bgHandler);

            // Timeout safety - if capture doesn't complete within 5s, release everything immediately
            bgHandler.postDelayed(() -> {
                if (finished.compareAndSet(false, true)) {
                    cleanup.run();
                    if (callback != null) callback.onError("Camera2 capture timed out");
                }
            }, 5000);

            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    cameraDeviceHolder[0] = camera;
                    if (finished.get()) {
                        cleanup.run();
                        return;
                    }
                    try {
                        camera.createCaptureSession(Collections.singletonList(reader.getSurface()),
                                new CameraCaptureSession.StateCallback() {
                                    @Override
                                    public void onConfigured(CameraCaptureSession session) {
                                        sessionHolder[0] = session;
                                        if (finished.get()) {
                                            cleanup.run();
                                            return;
                                        }
                                        try {
                                            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                            builder.addTarget(reader.getSurface());
                                            builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                            session.capture(builder.build(), null, bgHandler);
                                        } catch (Exception e) {
                                            if (finished.compareAndSet(false, true)) {
                                                cleanup.run();
                                                if (callback != null) callback.onError("Capture failed: " + e.getMessage());
                                            }
                                        }
                                    }

                                    @Override
                                    public void onConfigureFailed(CameraCaptureSession session) {
                                        if (finished.compareAndSet(false, true)) {
                                            cleanup.run();
                                            if (callback != null) callback.onError("CaptureSession config failed");
                                        }
                                    }
                                }, bgHandler);
                    } catch (Exception e) {
                        if (finished.compareAndSet(false, true)) {
                            cleanup.run();
                            if (callback != null) callback.onError("Create session error: " + e.getMessage());
                        }
                    }
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    cameraDeviceHolder[0] = camera;
                    if (finished.compareAndSet(false, true)) {
                        cleanup.run();
                        if (callback != null) callback.onError("Camera disconnected");
                    }
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    cameraDeviceHolder[0] = camera;
                    if (finished.compareAndSet(false, true)) {
                        cleanup.run();
                        if (callback != null) callback.onError("Camera error code: " + error);
                    }
                }
            }, bgHandler);

        } catch (SecurityException se) {
            thread.quitSafely();
            if (callback != null) callback.onError("SecurityException: " + se.getMessage());
        } catch (Exception e) {
            thread.quitSafely();
            if (callback != null) callback.onError("Camera2 error: " + e.getMessage());
        }
    }

    // -------------------------------------------------------------
    // Camera1 fallback (legacy devices)
    // -------------------------------------------------------------
    private static void tryCamera1(int facing, Callback callback) {
        new Thread(() -> {
            Camera camera = null;
            SurfaceTexture surfaceTexture = null;
            try {
                int cameraId = findCamera1(facing);
                if (cameraId == -1) {
                    if (callback != null) callback.onError("No camera matching facing found");
                    return;
                }

                try {
                    camera = Camera.open(cameraId);
                } catch (RuntimeException re) {
                    try {
                        Thread.sleep(600);
                        camera = Camera.open(cameraId);
                    } catch (Exception ex) {
                        throw re;
                    }
                }
                Camera.Parameters params = camera.getParameters();
                List<Camera.Size> sizes = params.getSupportedPreviewSizes();
                Camera.Size chosenSize = null;
                if (sizes != null && !sizes.isEmpty()) {
                    chosenSize = sizes.get(0);
                    for (Camera.Size s : sizes) {
                        if (s.width <= 1280 && s.width >= 640) {
                            chosenSize = s;
                            break;
                        }
                    }
                    params.setPreviewSize(chosenSize.width, chosenSize.height);
                }
                params.setPictureFormat(ImageFormat.JPEG);
                params.setJpegQuality(85);
                try { camera.setParameters(params); } catch (Exception ignored) {}

                surfaceTexture = new SurfaceTexture(42);
                camera.setPreviewTexture(surfaceTexture);
                camera.startPreview();

                final Camera finalCam = camera;
                final SurfaceTexture finalSt = surfaceTexture;
                final Camera.Size finalSize = chosenSize;
                final AtomicBoolean captured = new AtomicBoolean(false);

                finalCam.setOneShotPreviewCallback((data, cam) -> {
                    if (captured.compareAndSet(false, true)) {
                        byte[] jpeg = null;
                        if (data != null && finalSize != null) {
                            try {
                                YuvImage yuv = new YuvImage(data, ImageFormat.NV21, finalSize.width, finalSize.height, null);
                                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                yuv.compressToJpeg(new Rect(0, 0, finalSize.width, finalSize.height), 85, baos);
                                jpeg = baos.toByteArray();
                            } catch (Exception ignored) {}
                        }
                        releaseCamera1(finalCam, finalSt);
                        if (jpeg != null) {
                            if (callback != null) callback.onCaptured(jpeg);
                        } else {
                            if (callback != null) callback.onError("YUV compression failed");
                        }
                    }
                });

                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (captured.compareAndSet(false, true)) {
                        try {
                            finalCam.takePicture(null, null, (data, cam) -> {
                                try {
                                    if (data != null) {
                                        if (callback != null) callback.onCaptured(data);
                                    } else {
                                        if (callback != null) callback.onError("takePicture returned null");
                                    }
                                } finally {
                                    releaseCamera1(finalCam, finalSt);
                                }
                            });
                        } catch (Exception e) {
                            releaseCamera1(finalCam, finalSt);
                            if (callback != null) callback.onError("takePicture error: " + e.getMessage());
                        }
                    }
                }, 600);

            } catch (Exception e) {
                releaseCamera1(camera, surfaceTexture);
                if (callback != null) callback.onError("Camera1 error: " + e.getMessage());
            }
        }).start();
    }

    private static int findCamera1(int desiredFacing) {
        int numCameras = Camera.getNumberOfCameras();
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < numCameras; i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == desiredFacing) return i;
        }
        return numCameras > 0 ? 0 : -1;
    }

    private static void releaseCamera1(Camera camera, SurfaceTexture surfaceTexture) {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
            } catch (Exception ignored) {}
            try {
                camera.release();
            } catch (Exception ignored) {}
        }
        if (surfaceTexture != null) {
            try {
                surfaceTexture.release();
            } catch (Exception ignored) {}
        }
    }
}
