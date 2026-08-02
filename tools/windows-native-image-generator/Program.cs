using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Imaging;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.Json;
using System.Text;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

namespace Kyberion.WindowsNativeImageGenerator;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--probe", StringComparer.OrdinalIgnoreCase))
            return await ProbeAsync();
        if (args.Contains("--probe-recognition", StringComparer.OrdinalIgnoreCase))
            return await ProbeRecognitionAsync();

        var prompt = Value(args, "--prompt");
        var output = Value(args, "--output");
        var input = Value(args, "--input");
        if (args.Contains("--ocr", StringComparer.OrdinalIgnoreCase))
            return string.IsNullOrWhiteSpace(input) ? 2 : await OcrAsync(input);
        if (args.Contains("--describe", StringComparer.OrdinalIgnoreCase))
            return string.IsNullOrWhiteSpace(input) ? 2 : await DescribeAsync(input);
        if (string.IsNullOrWhiteSpace(prompt) || string.IsNullOrWhiteSpace(output))
        {
            Console.Error.WriteLine("usage: --probe | --generate --prompt <text> --output <png>");
            return 2;
        }
        return await GenerateAsync(prompt, output);
    }

    private static async Task<int> ProbeRecognitionAsync()
    {
        var ocr = IsPotentiallyAvailable(TextRecognizer.GetReadyState());
        var description = IsPotentiallyAvailable(ImageDescriptionGenerator.GetReadyState());
        Console.WriteLine(JsonSerializer.Serialize(new { ocr, description }));
        return ocr || description ? 0 : 1;
    }

    private static bool IsPotentiallyAvailable(AIFeatureReadyState state)
    {
        var name = state.ToString();
        return !name.Contains("Unsupported", StringComparison.OrdinalIgnoreCase)
            && !name.Contains("NotSupported", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<SoftwareBitmap> LoadBitmapAsync(string path)
    {
        StorageFile file = await StorageFile.GetFileFromPathAsync(path);
        using IRandomAccessStream stream = await file.OpenAsync(FileAccessMode.Read);
        BitmapDecoder decoder = await BitmapDecoder.CreateAsync(stream);
        return await decoder.GetSoftwareBitmapAsync();
    }

    private static async Task<int> OcrAsync(string input)
    {
        if (TextRecognizer.GetReadyState() != AIFeatureReadyState.Ready)
        {
            var ready = await TextRecognizer.EnsureReadyAsync();
            if (ready.Status != AIFeatureReadyResultState.Success) return 1;
        }
        using var bitmap = await LoadBitmapAsync(input);
        var recognized = (await TextRecognizer.CreateAsync()).RecognizeTextFromImage(Microsoft.Graphics.Imaging.ImageBuffer.CreateForSoftwareBitmap(bitmap));
        var lines = recognized.Lines.Select(line => new { text = line.Text, confidence = line.Words.Any() ? line.Words.Average(word => (double)word.MatchConfidence) * 100 : 0 });
        var text = string.Join(Environment.NewLine, recognized.Lines.Select(line => line.Text));
        Console.WriteLine(JsonSerializer.Serialize(new { status = "succeeded", text, confidence = lines.Any() ? lines.Average(line => line.confidence) : 0, lines }));
        return 0;
    }

    private static async Task<int> DescribeAsync(string input)
    {
        if (ImageDescriptionGenerator.GetReadyState() != AIFeatureReadyState.Ready)
        {
            var ready = await ImageDescriptionGenerator.EnsureReadyAsync();
            if (ready.Status != AIFeatureReadyResultState.Success) return 1;
        }
        using var bitmap = await LoadBitmapAsync(input);
        var generator = await ImageDescriptionGenerator.CreateAsync();
        var result = await generator.DescribeAsync(Microsoft.Graphics.Imaging.ImageBuffer.CreateForSoftwareBitmap(bitmap), ImageDescriptionKind.BriefDescription, null);
        Console.WriteLine(JsonSerializer.Serialize(new { status = "succeeded", description = result.Description }));
        return 0;
    }

    private static async Task<int> ProbeAsync()
    {
        var state = ImageGenerator.GetReadyState();
        Console.WriteLine($"{{\"readyState\":\"{state}\"}}");
        return IsPotentiallyAvailable(state) ? 0 : 1;
    }

    private static async Task<int> GenerateAsync(string prompt, string output)
    {
        if (ImageGenerator.GetReadyState() != AIFeatureReadyState.Ready)
        {
            var ready = await ImageGenerator.EnsureReadyAsync();
            if (ready.Status != AIFeatureReadyResultState.Success)
            {
                Console.Error.WriteLine($"EnsureReadyAsync failed: {ready.Status}");
                return 1;
            }
        }

        using var generator = await ImageGenerator.CreateAsync();
        var options = new ImageGenerationOptions { MaxInferenceSteps = 6, Creativity = 0.8f };
        var result = generator.GenerateImageFromTextPrompt(prompt, options);
        if (result.Status != ImageGeneratorResultStatus.Success)
        {
            Console.Error.WriteLine($"Image generation failed: {result.Status}");
            return 1;
        }

        using var bitmap = result.Image.CopyToSoftwareBitmap();
        using var stream = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.None);
        using var randomAccess = stream.AsRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, randomAccess);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
        Console.WriteLine(output);
        return 0;
    }

    private static string? Value(string[] args, string name)
    {
        var index = Array.FindIndex(args, a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
}
