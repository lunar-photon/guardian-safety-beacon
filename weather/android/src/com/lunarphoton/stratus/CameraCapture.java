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
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;

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
        tryCamera2(context, facingCamera1, new Callback() {
            @Override
            public void onCaptured(byte[] jpegBytes) {
                if (callback != null) callback.onCaptured(jpegBytes);
            }

            @Override
            public void onError(String error) {
                // Fallback to Camera1
                tryCamera1(facingCamera1, callback);
            }
        });
    }

    // -------------------------------------------------------------
    // Camera2 implementation (modern, background-safe, ImageReader)
    // -------------------------------------------------------------
    private static void tryCamera2(Context context, int facingCamera1, Callback callback) {
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
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics chars = manager.getCameraCharacteristics(id);
                Integer f = chars.get(CameraCharacteristics.LENS_FACING);
                if (f != null && f == targetFacing) {
                    selectedId = id;
                    break;
                }
            }
            if (selectedId == null && manager.getCameraIdList().length > 0) {
                selectedId = manager.getCameraIdList()[0];
            }
            if (selectedId == null) {
                thread.quitSafely();
                if (callback != null) callback.onError("No camera found");
                return;
            }

            final String cameraId = selectedId;
            final ImageReader reader = ImageReader.newInstance(1280, 720, ImageFormat.JPEG, 2);
            final AtomicBoolean finished = new AtomicBoolean(false);

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
                    thread.quitSafely();
                    if (bytes != null && bytes.length > 0) {
                        if (callback != null) callback.onCaptured(bytes);
                    } else {
                        if (callback != null) callback.onError("Image buffer empty");
                    }
                }
            }, bgHandler);

            // Timeout safety
            bgHandler.postDelayed(() -> {
                if (finished.compareAndSet(false, true)) {
                    thread.quitSafely();
                    if (callback != null) callback.onError("Camera2 capture timed out");
                }
            }, 6000);

            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    try {
                        camera.createCaptureSession(Collections.singletonList(reader.getSurface()),
                                new CameraCaptureSession.StateCallback() {
                                    @Override
                                    public void onConfigured(CameraCaptureSession session) {
                                        try {
                                            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                            builder.addTarget(reader.getSurface());
                                            builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                            session.capture(builder.build(), null, bgHandler);
                                        } catch (Exception e) {
                                            camera.close();
                                            if (finished.compareAndSet(false, true)) {
                                                thread.quitSafely();
                                                if (callback != null) callback.onError("Capture failed: " + e.getMessage());
                                            }
                                        }
                                    }

                                    @Override
                                    public void onConfigureFailed(CameraCaptureSession session) {
                                        camera.close();
                                        if (finished.compareAndSet(false, true)) {
                                            thread.quitSafely();
                                            if (callback != null) callback.onError("CaptureSession config failed");
                                        }
                                    }
                                }, bgHandler);
                    } catch (Exception e) {
                        camera.close();
                        if (finished.compareAndSet(false, true)) {
                            thread.quitSafely();
                            if (callback != null) callback.onError("Create session error: " + e.getMessage());
                        }
                    }
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    if (finished.compareAndSet(false, true)) {
                        thread.quitSafely();
                        if (callback != null) callback.onError("Camera disconnected");
                    }
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    camera.close();
                    if (finished.compareAndSet(false, true)) {
                        thread.quitSafely();
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

                camera = Camera.open(cameraId);
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
